use anyhow::{anyhow, bail, Context, Result};
use percent_encoding::percent_decode_str;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Client;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};

pub const ORIGIN: &str = "https://animejoya.ru";
pub const UA: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";

#[derive(Debug, Clone, Serialize)]
pub struct Source {
    pub quality: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Episode {
    pub player_id: String,
    pub title: String,
    pub sources: Vec<Source>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Player {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fact {
    pub key: String,
    pub value: String,
}

/// Шапка страницы тайтла: постер, описание, таблица характеристик.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Meta {
    pub title: String,
    pub original: String,
    pub poster: String,
    pub description: String,
    pub genres: Vec<String>,
    pub facts: Vec<Fact>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Playlist {
    pub players: Vec<Player>,
    pub episodes: Vec<Episode>,
}

impl Playlist {
    /// data-id иерархичен: `0_0` — плеер, `0_1_0` — озвучка `0_1` + плеер `_0`.
    pub fn player_name(&self, id: &str) -> String {
        let parts: Vec<&str> = id.split('_').collect();
        let chain: Vec<String> = (1..=parts.len())
            .map(|n| parts[..n].join("_"))
            .filter_map(|prefix| self.label(&prefix))
            .collect();
        if chain.is_empty() {
            id.to_string()
        } else {
            chain.join(" · ")
        }
    }

    fn label(&self, id: &str) -> Option<String> {
        self.players
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.clone())
    }

    /// Плееры, отдающие прямые ссылки на видео (а не чужой iframe).
    pub fn direct_players(&self) -> Vec<Player> {
        let mut ids: Vec<String> = Vec::new();
        for ep in &self.episodes {
            if !ep.sources.is_empty() && !ids.contains(&ep.player_id) {
                ids.push(ep.player_id.clone());
            }
        }
        ids.into_iter()
            .map(|id| Player {
                name: self.player_name(&id),
                id,
            })
            .collect()
    }

    pub fn external_names(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for ep in &self.episodes {
            if ep.sources.is_empty() {
                let leaf = self
                    .label(&ep.player_id)
                    .unwrap_or_else(|| ep.player_id.clone());
                if !out.contains(&leaf) {
                    out.push(leaf);
                }
            }
        }
        out
    }

    pub fn episodes_of(&self, player_id: &str) -> Vec<&Episode> {
        self.episodes
            .iter()
            .filter(|e| e.player_id == player_id)
            .collect()
    }
}

pub struct Site {
    pub http: Client,
}

impl Site {
    pub fn new() -> Result<Self> {
        let mut h = HeaderMap::new();
        h.insert(
            "Accept-Language",
            HeaderValue::from_static("ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.6"),
        );
        h.insert("DNT", HeaderValue::from_static("1"));
        h.insert("Upgrade-Insecure-Requests", HeaderValue::from_static("1"));

        let http = Client::builder()
            .user_agent(UA)
            .default_headers(h)
            .cookie_store(true)
            .gzip(true)
            .brotli(true)
            .timeout(std::time::Duration::from_secs(60))
            .build()?;
        Ok(Self { http })
    }

    /// GET страницы «как из браузера».
    pub async fn get_page(&self, url: &str) -> Result<String> {
        let r = self
            .http
            .get(url)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
            .header("Sec-Fetch-Dest", "document")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "none")
            .header("Sec-Fetch-User", "?1")
            .send()
            .await
            .with_context(|| format!("не удалось открыть {url}"))?;
        // Страница без прав доступа отдаётся с кодом 403, но с нужным HTML.
        Ok(r.text().await?)
    }

    pub async fn login(&self, user: &str, pass: &str, referer: &str) -> Result<()> {
        let form = [
            ("login_name", user),
            ("login_password", pass),
            ("login_not_save", "0"),
            ("login", "submit"),
        ];
        let r = self
            .http
            .post(referer)
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .header("Origin", ORIGIN)
            .header("Referer", referer)
            .header("Sec-Fetch-Dest", "document")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "same-origin")
            .header("Sec-Fetch-User", "?1")
            .form(&form)
            .send()
            .await
            .context("запрос авторизации не прошёл")?;
        let body = r.text().await?;
        if body.contains("name=\"login_name\"") {
            bail!("не удалось войти — проверьте логин и пароль");
        }
        Ok(())
    }

    /// Плейлист приходит отдельным ajax-запросом, в HTML страницы его нет.
    pub async fn playlist(&self, news_id: &str, referer: &str) -> Result<Playlist> {
        let url = format!("{ORIGIN}/engine/ajax/playlists.php?news_id={news_id}&xfield=playlist");
        let r = self
            .http
            .get(&url)
            .header("Accept", "application/json, text/javascript, */*; q=0.01")
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Referer", referer)
            .header("Sec-Fetch-Dest", "empty")
            .header("Sec-Fetch-Mode", "cors")
            .header("Sec-Fetch-Site", "same-origin")
            .send()
            .await
            .context("не удалось получить плейлист")?;

        let json: serde_json::Value = r.json().await.context("плейлист вернулся не в JSON")?;
        if json.get("success").and_then(|v| v.as_bool()) != Some(true) {
            bail!("сайт не отдал плейлист (нет доступа к этой странице?)");
        }
        let html = json
            .get("response")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("в ответе нет поля response"))?;

        Ok(parse_playlist(html))
    }
}

fn parse_playlist(html: &str) -> Playlist {
    let doc = Html::parse_fragment(html);
    let sel_players = Selector::parse(".playlists-lists li[data-id]").unwrap();
    let sel_eps = Selector::parse(".playlists-videos li[data-file]").unwrap();

    let players = doc
        .select(&sel_players)
        .filter_map(|el| {
            Some(Player {
                id: el.value().attr("data-id")?.to_string(),
                name: text_of(&el),
            })
        })
        .collect();

    let episodes = doc
        .select(&sel_eps)
        .filter_map(|el| {
            let file = el.value().attr("data-file")?;
            Some(Episode {
                player_id: el.value().attr("data-id").unwrap_or("?").to_string(),
                title: text_of(&el),
                sources: parse_sources(file),
            })
        })
        .collect();

    Playlist { players, episodes }
}

fn text_of(el: &ElementRef) -> String {
    el.text()
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `//animejoya.ru/player/playerjs.html?skip=..&file=[1080p]https://..a.mp4,[720p]https://..b.mp4`
fn parse_sources(data_file: &str) -> Vec<Source> {
    if !data_file.contains("playerjs.html") {
        return Vec::new();
    }
    let Some(idx) = data_file.find("file=") else {
        return Vec::new();
    };
    let raw = &data_file[idx + "file=".len()..];
    let list = percent_decode_str(raw).decode_utf8_lossy().to_string();

    // Границы записей — `[` в начале строки или сразу после запятой.
    let marks: Vec<usize> = list
        .match_indices('[')
        .map(|(i, _)| i)
        .filter(|&i| i == 0 || list[..i].ends_with(','))
        .collect();

    if marks.is_empty() {
        let url = list.trim().to_string();
        return if url.starts_with("http") {
            vec![Source {
                quality: "video".into(),
                url,
            }]
        } else {
            Vec::new()
        };
    }

    let mut out = Vec::new();
    for (n, &start) in marks.iter().enumerate() {
        let end = marks.get(n + 1).map(|&e| e - 1).unwrap_or(list.len());
        let entry = &list[start..end];
        let Some(close) = entry.find(']') else {
            continue;
        };
        let url = entry[close + 1..].trim().to_string();
        if url.starts_with("http") {
            out.push(Source {
                quality: entry[1..close].to_string(),
                url,
            });
        }
    }
    out
}

/// news_id нужен для ajax-запроса плейлиста.
pub fn parse_news_id(html: &str) -> Option<String> {
    let i = html.find("data-news_id=")?;
    let rest = &html[i + "data-news_id=".len()..];
    let rest = rest.trim_start_matches(['"', '\'']);
    let id: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!id.is_empty()).then_some(id)
}

pub fn parse_meta(html: &str) -> Meta {
    let doc = Html::parse_document(html);
    let one = |css: &str| -> Option<String> {
        Selector::parse(css)
            .ok()
            .and_then(|s| doc.select(&s).next().map(|el| text_of(&el)))
    };
    let attr = |css: &str, name: &str| -> Option<String> {
        Selector::parse(css)
            .ok()
            .and_then(|s| doc.select(&s).next())
            .and_then(|el| el.value().attr(name).map(str::to_string))
    };

    let mut facts = Vec::new();
    let mut genres = Vec::new();
    if let Ok(sel) = Selector::parse(".blkdesc p") {
        let label = Selector::parse(".timpact").unwrap();
        let link = Selector::parse("a").unwrap();
        for p in doc.select(&sel) {
            let Some(lab) = p.select(&label).next() else {
                continue;
            };
            let key = text_of(&lab).trim_end_matches(':').to_string();
            let full = text_of(&p);
            let value = full
                .strip_prefix(&text_of(&lab))
                .unwrap_or(&full)
                .trim()
                .to_string();
            if key.eq_ignore_ascii_case("жанр") {
                genres = p.select(&link).map(|a| text_of(&a)).collect();
            }
            if !value.is_empty() {
                facts.push(Fact { key, value });
            }
        }
    }

    Meta {
        title: one("h1").unwrap_or_else(|| "Без названия".into()),
        original: one("h2.romanji").unwrap_or_default(),
        poster: attr("meta[property=\"og:image\"]", "content").unwrap_or_default(),
        description: one("[itemprop=description]")
            .map(|d| d.trim_start_matches("Описание:").trim().to_string())
            .or_else(|| attr("meta[property=\"og:description\"]", "content"))
            .unwrap_or_default(),
        genres,
        facts,
    }
}

/// У гостя страница отдаётся с формой входа и без плейлиста.
pub fn is_authorized(html: &str) -> bool {
    !html.contains("name=\"login_name\"") && parse_news_id(html).is_some()
}

/// Ссылки на видео лежат на CDN и берутся уже без кук, но с браузерными заголовками.
pub fn media_client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent(UA)
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()?)
}
