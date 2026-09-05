use anyhow::{bail, Context, Result};
use std::path::Path;
use tokio::process::Command;

fn one(cmd: &str) -> Vec<String> {
    vec![cmd.to_string()]
}

/// Что пробуем, если плеер не задан явно. Каждый вариант — уже разобранные argv,
/// потому что пути вроде `C:\Program Files\...` нельзя резать по пробелам.
#[cfg(windows)]
fn defaults() -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = vec![one("mpv"), one("vlc"), one("ffplay")];
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        let Some(base) = std::env::var_os(var).map(std::path::PathBuf::from) else {
            continue;
        };
        out.push(one(&base.join("mpv").join("mpv.exe").to_string_lossy()));
        out.push(one(&base
            .join("VideoLAN")
            .join("VLC")
            .join("vlc.exe")
            .to_string_lossy()));
    }
    out.push(
        ["cmd", "/c", "start", ""]
            .iter()
            .map(|s| s.to_string())
            .collect(),
    );
    out
}

#[cfg(not(windows))]
fn defaults() -> Vec<Vec<String>> {
    vec![one("mpv"), one("vlc"), one("ffplay"), one("xdg-open")]
}

fn candidates(configured: Option<&str>) -> Vec<Vec<String>> {
    std::env::var("ANIMEJOYA_PLAYER")
        .ok()
        .or_else(|| configured.map(str::to_string))
        .filter(|p| !p.trim().is_empty())
        .map(|p| vec![p.split_whitespace().map(String::from).collect()])
        .unwrap_or_else(defaults)
}

/// Запускает плеер и не ждёт его — окно приложения остаётся отзывчивым.
pub async fn launch(
    configured: Option<&str>,
    target: &str,
    title: &str,
    referer: Option<&str>,
) -> Result<String> {
    for c in candidates(configured) {
        let Some((bin, args)) = c.split_first() else {
            continue;
        };
        let stem = Path::new(bin)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let mut cmd = Command::new(bin);
        cmd.args(args);
        match stem {
            "ffplay" => {
                cmd.arg("-autoexit");
                if let Some(r) = referer {
                    cmd.arg("-headers").arg(format!("Referer: {r}\r\n"));
                }
            }
            "mpv" => {
                cmd.arg(format!("--force-media-title={title}"));
                if let Some(r) = referer {
                    cmd.arg(format!("--referrer={r}"));
                }
            }
            "vlc" => {
                if let Some(r) = referer {
                    cmd.arg(format!("--http-referrer={r}"));
                }
            }
            _ => {}
        }
        cmd.arg(target);
        cmd.kill_on_drop(false);
        match cmd.spawn() {
            Ok(mut child) => {
                tokio::spawn(async move {
                    let _ = child.wait().await;
                });
                return Ok(bin.clone());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e).context(format!("не удалось запустить {bin}")),
        }
    }
    bail!("плеер не найден — поставьте mpv или укажите его в настройках")
}

/// Показать папку в системном файловом менеджере.
pub async fn reveal(path: &str) -> Result<()> {
    let bin = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(bin)
        .arg(path)
        .spawn()
        .with_context(|| format!("не удалось открыть {path}"))?;
    Ok(())
}
