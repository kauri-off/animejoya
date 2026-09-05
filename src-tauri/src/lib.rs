mod download;
mod player;
mod site;
mod store;

use serde::Serialize;
use site::{Player, Site, Source};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use store::{Entry, Settings};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

pub struct App {
    site: Site,
    authorized: Mutex<bool>,
    library: Mutex<Vec<Entry>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    media: reqwest::Client,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeView {
    title: String,
    tag: String,
    sources: Vec<Source>,
    /// Путь к уже скачанному файлу, если он лежит на диске.
    file: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerView {
    id: String,
    name: String,
    episodes: Vec<EpisodeView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TitleView {
    entry: Entry,
    players: Vec<PlayerView>,
    external: Vec<String>,
    dir: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Finished {
    id: String,
    file: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Failed {
    id: String,
    message: String,
}

impl App {
    /// Открывает страницу тайтла, при необходимости логинясь один раз за сессию.
    async fn page(&self, url: &str) -> anyhow::Result<String> {
        let mut html = self.site.get_page(url).await?;
        if site::is_authorized(&html) {
            *self.authorized.lock().await = true;
            return Ok(html);
        }
        let cfg = store::load_settings()?;
        if cfg.username.is_empty() {
            anyhow::bail!("нужен вход: укажите логин и пароль в настройках");
        }
        self.site.login(&cfg.username, &cfg.password, url).await?;
        html = self.site.get_page(url).await?;
        if !site::is_authorized(&html) {
            anyhow::bail!("страница недоступна — проверьте ссылку и права аккаунта");
        }
        *self.authorized.lock().await = true;
        Ok(html)
    }
}

fn merge(entry: &mut Entry, meta: site::Meta) {
    entry.title = meta.title;
    entry.original = meta.original;
    entry.poster = meta.poster;
    entry.description = meta.description;
    entry.genres = meta.genres;
    entry.facts = meta.facts;
}

impl App {
    /// Кладёт свежие метаданные в библиотеку, добавляя запись при первой встрече.
    async fn upsert(&self, url: &str, meta: site::Meta) -> anyhow::Result<Entry> {
        let mut lib = self.library.lock().await;
        let entry = match lib.iter_mut().find(|e| e.url == url) {
            Some(e) => {
                merge(e, meta);
                e.clone()
            }
            None => {
                let mut e = Entry {
                    url: url.to_string(),
                    added_at: store::now(),
                    ..Default::default()
                };
                merge(&mut e, meta);
                lib.insert(0, e.clone());
                e
            }
        };
        store::save_library(&lib)?;
        Ok(entry)
    }
}

fn dest_path(cfg: &Settings, page_url: &str, ep_title: &str, quality: &str) -> PathBuf {
    store::video_dir(cfg)
        .join(store::slug(page_url))
        .join(format!("{}-{}.mp4", store::ep_tag(ep_title), quality))
}

#[tauri::command]
async fn settings_get() -> Res<Settings> {
    store::load_settings().map_err(err)
}

#[tauri::command]
async fn settings_set(settings: Settings) -> Res<()> {
    store::save_settings(&settings).map_err(err)
}

#[tauri::command]
async fn library_get(app: State<'_, App>) -> Res<Vec<Entry>> {
    Ok(app.library.lock().await.clone())
}

/// Добавляет ссылку и сразу подтягивает обложку с описанием.
#[tauri::command]
async fn library_add(app: State<'_, App>, url: String) -> Res<Entry> {
    let url = store::normalize_url(&url);
    if !url.contains("animejoya") {
        return Err("это не ссылка на animejoya.ru".into());
    }
    let html = app.page(&url).await.map_err(err)?;
    let meta = site::parse_meta(&html);

    let entry = app.upsert(&url, meta).await.map_err(err)?;
    Ok(entry)
}

/// Догружает обложки и описания для записей, где их ещё нет
/// (например, после переезда со старого links.json).
#[tauri::command]
async fn library_sync(app: State<'_, App>, handle: AppHandle, force: bool) -> Res<()> {
    let todo: Vec<String> = app
        .library
        .lock()
        .await
        .iter()
        .filter(|e| force || e.poster.is_empty())
        .map(|e| e.url.clone())
        .collect();
    if todo.is_empty() {
        return Ok(());
    }

    tokio::spawn(async move {
        let _ = handle.emit("library:syncing", todo.len());
        for url in todo {
            let Some(state) = handle.try_state::<App>() else {
                break;
            };
            let Ok(html) = state.page(&url).await else {
                continue;
            };
            let meta = site::parse_meta(&html);
            if let Ok(entry) = state.upsert(&url, meta).await {
                let _ = handle.emit("library:entry", entry);
            }
        }
        let _ = handle.emit("library:syncing", 0usize);
    });
    Ok(())
}

#[tauri::command]
async fn library_remove(app: State<'_, App>, url: String) -> Res<()> {
    let mut lib = app.library.lock().await;
    lib.retain(|e| e.url != url);
    store::save_library(&lib).map_err(err)
}

/// Полная карточка тайтла: озвучки, серии, что уже лежит на диске.
#[tauri::command]
async fn title_open(app: State<'_, App>, url: String) -> Res<TitleView> {
    let url = store::normalize_url(&url);
    let html = app.page(&url).await.map_err(err)?;
    let news_id = site::parse_news_id(&html)
        .ok_or("на странице нет плейлиста (это точно страница тайтла?)")?;
    let meta = site::parse_meta(&html);
    let playlist = app.site.playlist(&news_id, &url).await.map_err(err)?;

    let cfg = store::load_settings().map_err(err)?;
    let dir = store::video_dir(&cfg).join(store::slug(&url));

    let players = playlist
        .direct_players()
        .into_iter()
        .map(|p: Player| PlayerView {
            episodes: playlist
                .episodes_of(&p.id)
                .into_iter()
                .map(|e| {
                    let tag = store::ep_tag(&e.title);
                    let file = e.sources.iter().find_map(|s| {
                        let path = dir.join(format!("{tag}-{}.mp4", s.quality));
                        path.exists().then(|| path.to_string_lossy().to_string())
                    });
                    EpisodeView {
                        title: e.title.clone(),
                        tag,
                        sources: e.sources.clone(),
                        file,
                    }
                })
                .collect(),
            id: p.id,
            name: p.name,
        })
        .collect();

    let entry = app.upsert(&url, meta).await.map_err(err)?;

    Ok(TitleView {
        entry,
        players,
        external: playlist.external_names(),
        dir: dir.to_string_lossy().to_string(),
    })
}

/// Запоминает последнюю озвучку/качество, чтобы не спрашивать их каждый раз.
#[tauri::command]
async fn remember_choice(
    app: State<'_, App>,
    url: String,
    player: Option<String>,
    quality: Option<String>,
) -> Res<()> {
    let mut lib = app.library.lock().await;
    if let Some(e) = lib.iter_mut().find(|e| e.url == url) {
        if player.is_some() {
            e.last_player = player;
        }
        if quality.is_some() {
            e.last_quality = quality;
        }
    }
    store::save_library(&lib).map_err(err)
}

#[tauri::command]
async fn mark_watched(
    app: State<'_, App>,
    url: String,
    episode: String,
    watched: bool,
) -> Res<Vec<String>> {
    let mut lib = app.library.lock().await;
    let Some(e) = lib.iter_mut().find(|e| e.url == url) else {
        return Ok(Vec::new());
    };
    e.watched.retain(|w| w != &episode);
    if watched {
        e.watched.push(episode);
    }
    let out = e.watched.clone();
    store::save_library(&lib).map_err(err)?;
    Ok(out)
}

/// Смотреть сразу с CDN, без сохранения файла.
#[tauri::command]
async fn stream(url: String, title: String) -> Res<String> {
    let cfg = store::load_settings().map_err(err)?;
    player::launch(cfg.player.as_deref(), &url, &title)
        .await
        .map_err(err)
}

#[tauri::command]
async fn play_file(path: String, title: String) -> Res<String> {
    let cfg = store::load_settings().map_err(err)?;
    player::launch(cfg.player.as_deref(), &path, &title)
        .await
        .map_err(err)
}

/// Ставит серию в загрузку; прогресс приходит событиями `download:*`.
#[tauri::command]
async fn download_start(
    app: State<'_, App>,
    handle: AppHandle,
    page_url: String,
    episode: String,
    quality: String,
    source_url: String,
    autoplay: bool,
) -> Res<String> {
    let cfg = store::load_settings().map_err(err)?;
    let dest = dest_path(&cfg, &page_url, &episode, &quality);
    let id = dest.to_string_lossy().to_string();

    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut cancels = app.cancels.lock().await;
        if cancels.contains_key(&id) {
            return Ok(id);
        }
        cancels.insert(id.clone(), flag.clone());
    }

    let media = app.media.clone();
    let task_id = id.clone();
    let player_cfg = cfg.player.clone();
    tokio::spawn(async move {
        let cancel = download::Cancel(flag);
        let emit_id = task_id.clone();
        let progress_handle = handle.clone();
        let res = download::fetch(
            &media,
            &source_url,
            &dest,
            &cancel,
            move |done, total, bps| {
                let _ = progress_handle.emit(
                    "download:progress",
                    download::Progress {
                        id: emit_id.clone(),
                        done,
                        total,
                        bytes_per_sec: bps,
                    },
                );
            },
        )
        .await;

        if let Some(state) = handle.try_state::<App>() {
            state.cancels.lock().await.remove(&task_id);
        }

        match res {
            Ok(file) => {
                let path = file.to_string_lossy().to_string();
                let _ = handle.emit(
                    "download:done",
                    Finished {
                        id: task_id,
                        file: path.clone(),
                    },
                );
                if autoplay {
                    if let Err(e) = player::launch(player_cfg.as_deref(), &path, &episode).await {
                        let _ = handle.emit("player:error", err(e));
                    }
                }
            }
            Err(e) => {
                let _ = handle.emit(
                    "download:failed",
                    Failed {
                        id: task_id,
                        message: err(e),
                    },
                );
            }
        }
    });

    Ok(id)
}

#[tauri::command]
async fn download_cancel(app: State<'_, App>, id: String) -> Res<()> {
    if let Some(flag) = app.cancels.lock().await.remove(&id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
async fn open_dir(path: String) -> Res<()> {
    tokio::fs::create_dir_all(&path).await.map_err(err)?;
    player::reveal(&path).await.map_err(err)
}

#[tauri::command]
async fn file_delete(path: String) -> Res<()> {
    tokio::fs::remove_file(&path).await.map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(App {
                site: Site::new()?,
                authorized: Mutex::new(false),
                library: Mutex::new(store::load_library()?),
                cancels: Mutex::new(HashMap::new()),
                media: site::media_client()?,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_set,
            library_get,
            library_add,
            library_sync,
            library_remove,
            title_open,
            remember_choice,
            mark_watched,
            stream,
            play_file,
            download_start,
            download_cancel,
            file_delete,
            open_dir,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить приложение");
}
