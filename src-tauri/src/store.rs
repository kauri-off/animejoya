use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::site::Fact;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub video_dir: Option<String>,
    #[serde(default)]
    pub player: Option<String>,
    /// Смотреть прямо с CDN, не сохраняя файл на диск.
    #[serde(default)]
    pub stream_by_default: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub original: String,
    #[serde(default)]
    pub poster: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub genres: Vec<String>,
    #[serde(default)]
    pub facts: Vec<Fact>,
    #[serde(default)]
    pub watched: Vec<String>,
    #[serde(default)]
    pub last_player: Option<String>,
    #[serde(default)]
    pub last_quality: Option<String>,
    #[serde(default)]
    pub added_at: u64,
}

#[derive(Serialize, Deserialize, Default)]
struct OldLink {
    url: String,
    #[serde(default)]
    title: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

pub fn config_dir() -> Result<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|h| h.join("AppData").join("Roaming")))
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|h| h.join(".config")))
    }
    .ok_or_else(|| anyhow!("не найдена домашняя папка пользователя"))?;
    let dir = base.join("animejoya");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    std::fs::write(path, serde_json::to_string_pretty(value)?)?;
    Ok(())
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict(_: &Path) {}

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn load_settings() -> Result<Settings> {
    Ok(read_json(&config_dir()?.join("config.json")))
}

pub fn save_settings(s: &Settings) -> Result<()> {
    let path = config_dir()?.join("config.json");
    write_json(&path, s)?;
    restrict(&path);
    Ok(())
}

fn library_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("library.json"))
}

/// Первый запуск после CLI-версии: подхватываем старый links.json.
pub fn load_library() -> Result<Vec<Entry>> {
    let path = library_path()?;
    if path.exists() {
        return Ok(read_json(&path));
    }
    let old: Vec<OldLink> = read_json(&config_dir()?.join("links.json"));
    Ok(old
        .into_iter()
        .map(|l| Entry {
            url: l.url,
            title: l.title,
            added_at: now(),
            ..Default::default()
        })
        .collect())
}

pub fn save_library(items: &[Entry]) -> Result<()> {
    write_json(&library_path()?, &items)
}

pub fn video_dir(s: &Settings) -> PathBuf {
    if let Some(d) = std::env::var_os("ANIMEJOYA_DIR") {
        return PathBuf::from(d);
    }
    if let Some(d) = s.video_dir.as_ref().filter(|d| !d.trim().is_empty()) {
        return PathBuf::from(d);
    }
    home_dir()
        .unwrap_or_default()
        .join("Videos")
        .join("AnimeJoy")
}

/// `.../5499-o-moem-pererozhdenii-v-sliz-4-sezon.html` -> `5499-o-moem-...`
pub fn slug(url: &str) -> String {
    url.rsplit('/')
        .next()
        .unwrap_or(url)
        .trim_end_matches(".html")
        .to_string()
}

/// «21 серия» -> «21», иначе безопасное имя из заголовка.
pub fn ep_tag(title: &str) -> String {
    let num: String = title.chars().take_while(|c| c.is_ascii_digit()).collect();
    if num.is_empty() {
        title
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect()
    } else {
        format!("{num:0>2}")
    }
}

pub fn normalize_url(url: &str) -> String {
    let u = url.trim();
    if u.starts_with("http") {
        u.to_string()
    } else {
        format!("https://{}", u.trim_start_matches("//"))
    }
}
