use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use reqwest::header::{CONTENT_LENGTH, RANGE};
use reqwest::Client;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::fs::{self, File, OpenOptions};
use tokio::io::AsyncWriteExt;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub done: u64,
    pub total: u64,
    pub bytes_per_sec: u64,
}

pub struct Cancel(pub Arc<AtomicBool>);

impl Cancel {
    pub fn stopped(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Качает файл целиком (с докачкой), сообщая о прогрессе через `on_progress`.
pub async fn fetch<F>(
    http: &Client,
    url: &str,
    dest: &Path,
    cancel: &Cancel,
    mut on_progress: F,
) -> Result<PathBuf>
where
    F: FnMut(u64, u64, u64),
{
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).await?;
    }

    let total = remote_size(http, url).await;

    if let Ok(m) = fs::metadata(dest).await {
        if total.is_none() || Some(m.len()) == total {
            return Ok(dest.to_path_buf());
        }
    }

    let part = dest.with_extension("mp4.part");
    let mut done = fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);
    // Битый огрызок больше исходника перекачиваем с нуля.
    if let (Some(t), true) = (total, done > 0) {
        if done > t {
            fs::remove_file(&part).await?;
            done = 0;
        }
    }

    if Some(done) == total && done > 0 {
        replace(&part, dest).await?;
        return Ok(dest.to_path_buf());
    }

    let mut req = http
        .get(url)
        .header("Accept", "video/webm,video/ogg,video/*;q=0.9,*/*;q=0.5")
        .header("Referer", crate::site::ORIGIN)
        .header("Sec-Fetch-Dest", "video")
        .header("Sec-Fetch-Mode", "no-cors")
        .header("Sec-Fetch-Site", "cross-site");
    if done > 0 {
        req = req.header(RANGE, format!("bytes={done}-"));
    }

    let resp = req.send().await.context("не удалось начать загрузку")?;
    if !resp.status().is_success() {
        bail!("сервер видео ответил {}", resp.status());
    }
    // Если докачка не поддержана — начинаем заново.
    let resume = done > 0 && resp.status().as_u16() == 206;
    let start = if resume { done } else { 0 };
    let total = total.unwrap_or_else(|| {
        start
            + resp
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(num)
                .unwrap_or(0)
    });

    let mut file = if resume {
        OpenOptions::new().append(true).open(&part).await?
    } else {
        File::create(&part).await?
    };

    let mut written = start;
    let mut stream = resp.bytes_stream();
    let mut tick = std::time::Instant::now();
    let mut tick_bytes = written;
    on_progress(written, total, 0);

    while let Some(chunk) = stream.next().await {
        if cancel.stopped() {
            file.flush().await?;
            bail!("загрузка отменена");
        }
        let chunk = chunk.context("обрыв загрузки")?;
        file.write_all(&chunk).await?;
        written += chunk.len() as u64;

        let elapsed = tick.elapsed();
        if elapsed.as_millis() >= 250 {
            let speed = (written - tick_bytes) as f64 / elapsed.as_secs_f64();
            on_progress(written, total, speed as u64);
            tick = std::time::Instant::now();
            tick_bytes = written;
        }
    }
    file.flush().await?;
    drop(file);

    if total > 0 && written < total {
        bail!("скачано {written} из {total} байт — запустите ещё раз, докачается");
    }
    on_progress(written, total.max(written), 0);
    replace(&part, dest).await?;
    Ok(dest.to_path_buf())
}

/// На Windows rename не перезаписывает существующий файл, в отличие от unix.
async fn replace(from: &Path, to: &Path) -> Result<()> {
    if cfg!(windows) && to.exists() {
        fs::remove_file(to).await?;
    }
    fs::rename(from, to).await?;
    Ok(())
}

fn num(v: &reqwest::header::HeaderValue) -> Option<u64> {
    v.to_str().ok()?.parse().ok()
}

async fn remote_size(http: &Client, url: &str) -> Option<u64> {
    let r = http
        .head(url)
        .header("Referer", crate::site::ORIGIN)
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.headers().get(CONTENT_LENGTH).and_then(num)
}
