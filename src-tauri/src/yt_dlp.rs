/// yt-dlp integration for NetGuard
///
/// Routes YouTube / SoundCloud / other yt-dlp-supported URLs through the
/// yt-dlp binary instead of the raw HTTP segment engine.
///
/// Features:
/// - Auto-discovers yt-dlp in PATH and common install locations
/// - `--cookies-from-browser chrome` (or user-configured browser) so
///   age-restricted / signed-in content works automatically
/// - Parses yt-dlp's `--progress --newline` output → real-time progress
/// - Kill-on-cancel support
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use tauri::Emitter;

use crate::types::EngineState;

#[derive(serde::Serialize, Clone)]
pub struct YtdlpLogEvent {
    pub download_id: String,
    pub level: String, // "cmd" | "stdout" | "stderr" | "error" | "info"
    pub msg: String,
}

fn emit_log(app: &tauri::AppHandle, download_id: &str, level: &str, msg: &str) {
    let _ = app.emit("yt-dlp:log", YtdlpLogEvent {
        download_id: download_id.to_string(),
        level: level.to_string(),
        msg: msg.to_string(),
    });
}

// ── yt-dlp update helpers ─────────────────────────────────────────────────────

/// Get the currently installed yt-dlp version string (e.g. "2024.11.18").
/// Returns None if yt-dlp is not found or version query fails.
pub async fn get_installed_version(bin: &PathBuf) -> Option<String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("--version");
    #[cfg(windows)] { cmd.creation_flags(0x08000000); }
    let out = cmd.output().await.ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

const GITHUB_LATEST_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const GITHUB_LATEST_PAGE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest";
const GITHUB_DOWNLOAD_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/download";
const GITHUB_ASSET_PREFIX: &str = "https://github.com/yt-dlp/yt-dlp/";
const SUMS_FILE: &str = "SHA2-256SUMS";
/// A real yt-dlp binary is >10 MB; anything smaller is an error page or truncated download.
const MIN_BINARY_BYTES: usize = 1_000_000;

/// Name of the release asset for the current platform.
pub fn release_asset_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp"
    }
}

fn http_client(timeout_secs: u64, follow_redirects: bool) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder()
        .user_agent("NetGuard/1.0.0")
        .timeout(std::time::Duration::from_secs(timeout_secs));
    if !follow_redirects {
        b = b.redirect(reqwest::redirect::Policy::none());
    }
    b.build().map_err(|e| format!("Could not create HTTP client: {e}"))
}

fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 64
        && tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Interpret a GitHub "latest release" API response.
/// Pure function (no I/O) so every failure mode can be unit-tested.
pub fn parse_latest_release(
    status: u16,
    ratelimit_remaining: Option<&str>,
    body: &str,
    asset_name: &str,
) -> Result<(String, String), String> {
    let json: Option<serde_json::Value> = serde_json::from_str(body).ok();
    let api_message = json
        .as_ref()
        .and_then(|j| j["message"].as_str())
        .map(|m| m.to_string());

    if !(200..300).contains(&status) {
        let lower = api_message.clone().unwrap_or_default().to_lowercase();
        if status == 429
            || (status == 403 && (ratelimit_remaining == Some("0") || lower.contains("rate limit")))
        {
            return Err(format!(
                "GitHub API rate limit exceeded (HTTP {status}); try again later"
            ));
        }
        return Err(match api_message {
            Some(m) => format!("GitHub API returned HTTP {status}: {m}"),
            None => format!("GitHub API returned HTTP {status}"),
        });
    }

    let json = json.ok_or_else(|| {
        format!("GitHub API returned a non-JSON response ({} bytes)", body.len())
    })?;

    let tag = json["tag_name"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| match &api_message {
            Some(m) => format!("GitHub response had no tag_name (message: {m})"),
            None => "GitHub response had no tag_name".to_string(),
        })?
        .to_string();
    if !valid_tag(&tag) {
        return Err(format!("GitHub returned an unexpected tag_name: {tag:?}"));
    }

    let assets = json["assets"]
        .as_array()
        .ok_or_else(|| format!("Release {tag} has no assets list"))?;
    let url = assets
        .iter()
        .find(|a| a["name"].as_str() == Some(asset_name))
        .and_then(|a| a["browser_download_url"].as_str())
        .ok_or_else(|| format!("Asset '{asset_name}' not found in release {tag}"))?
        .to_string();
    if !url.starts_with(GITHUB_ASSET_PREFIX) {
        return Err(format!("Refusing unexpected download host for {asset_name}: {url}"));
    }
    Ok((tag, url))
}

/// Extract the release tag from a `Location: .../releases/tag/<tag>` header value.
pub fn tag_from_location(location: &str) -> Option<String> {
    let tag = location.rsplit_once("/tag/")?.1.trim().trim_end_matches('/');
    if valid_tag(tag) { Some(tag.to_string()) } else { None }
}

async fn fetch_release_via_api(api_url: &str, asset: &str) -> Result<(String, String), String> {
    let client = http_client(15, true)?;
    let resp = client
        .get(api_url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("network error contacting GitHub API: {e}"))?;
    let status = resp.status().as_u16();
    let remaining = resp
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let body = resp
        .text()
        .await
        .map_err(|e| format!("could not read GitHub API response: {e}"))?;
    parse_latest_release(status, remaining.as_deref(), &body, asset)
}

/// Fallback that does not use the rate-limited API: `/releases/latest` redirects to `/releases/tag/<tag>`.
async fn fetch_release_via_redirect(
    page_url: &str,
    download_base: &str,
    asset: &str,
) -> Result<(String, String), String> {
    let client = http_client(15, false)?;
    let resp = client
        .get(page_url)
        .send()
        .await
        .map_err(|e| format!("network error contacting GitHub: {e}"))?;
    let status = resp.status();
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("expected a redirect from {page_url}, got HTTP {status}"))?;
    let tag = tag_from_location(location)
        .ok_or_else(|| format!("could not read a release tag from redirect target {location:?}"))?;
    let url = format!("{download_base}/{tag}/{asset}");
    Ok((tag, url))
}

async fn get_latest_release_from(
    api_url: &str,
    page_url: &str,
    download_base: &str,
    asset: &str,
) -> Result<(String, String), String> {
    let api_err = match fetch_release_via_api(api_url, asset).await {
        Ok(r) => return Ok(r),
        Err(e) => e,
    };
    log::warn!("[yt-dlp] GitHub API lookup failed ({api_err}); trying release-page fallback");
    match fetch_release_via_redirect(page_url, download_base, asset).await {
        Ok(r) => Ok(r),
        Err(fb) => Err(format!(
            "Could not determine the latest yt-dlp release. GitHub API: {api_err}. Fallback: {fb}"
        )),
    }
}

/// Fetch the latest yt-dlp release tag from GitHub.
/// Returns (tag_name, asset_download_url) for the platform-appropriate binary.
/// Uses the Releases API and falls back to the `/releases/latest` redirect when the API
/// is rate-limited, blocked or returns an unexpected payload.
pub async fn get_latest_release() -> Result<(String, String), String> {
    get_latest_release_from(
        GITHUB_LATEST_API,
        GITHUB_LATEST_PAGE,
        GITHUB_DOWNLOAD_BASE,
        release_asset_name(),
    )
    .await
}

// ── Integrity checks ──────────────────────────────────────────────────────────

/// Find the SHA-256 for `name` in a `SHA2-256SUMS` file ("<hash>  <file>" per line).
pub fn parse_sha256sums(text: &str, name: &str) -> Option<String> {
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(hash), Some(file)) = (it.next(), it.next()) else { continue };
        if file.trim_start_matches('*') == name
            && hash.len() == 64
            && hash.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Some(hash.to_lowercase());
        }
    }
    None
}

fn asset_name_from_url(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or("")
}

/// Validate downloaded bytes: plausible size, correct executable header and SHA-256.
pub fn check_binary_bytes(bytes: &[u8], asset_name: &str, expected_sha256: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    if bytes.len() < MIN_BINARY_BYTES {
        return Err(format!(
            "Downloaded {asset_name} is only {} bytes — not a valid yt-dlp binary",
            bytes.len()
        ));
    }
    if asset_name.ends_with(".exe") && !bytes.starts_with(b"MZ") {
        return Err(format!("Downloaded {asset_name} is not a Windows executable"));
    }
    let got = hex::encode(Sha256::digest(bytes));
    if !got.eq_ignore_ascii_case(expected_sha256) {
        return Err(format!(
            "Checksum mismatch for {asset_name}: expected {expected_sha256}, got {got}"
        ));
    }
    Ok(())
}

/// Download `SHA2-256SUMS` next to the asset and return the expected hash for it.
pub async fn fetch_expected_hash(asset_url: &str) -> Result<String, String> {
    let name = asset_name_from_url(asset_url);
    let (dir, _) = asset_url
        .rsplit_once('/')
        .ok_or_else(|| format!("Invalid download URL: {asset_url}"))?;
    let sums_url = format!("{dir}/{SUMS_FILE}");
    let client = http_client(30, true)?;
    let resp = client
        .get(&sums_url)
        .send()
        .await
        .map_err(|e| format!("Could not fetch {SUMS_FILE}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} fetching {SUMS_FILE}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| format!("Could not read {SUMS_FILE}: {e}"))?;
    parse_sha256sums(&text, name).ok_or_else(|| format!("No checksum for {name} in {SUMS_FILE}"))
}

/// Verify a file already written to disk (used by the Settings → Install flow).
pub async fn verify_file(path: &std::path::Path, asset_url: &str) -> Result<(), String> {
    let expected = fetch_expected_hash(asset_url).await?;
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Cannot read downloaded file {}: {e}", path.display()))?;
    check_binary_bytes(&bytes, asset_name_from_url(asset_url), &expected)
}

/// Download the latest yt-dlp binary and write it to `dest`.
/// The file is verified (size, header, SHA-256) before it replaces `dest`.
/// On Unix sets executable bit.
pub async fn download_yt_dlp(download_url: &str, dest: &PathBuf) -> Result<(), String> {
    let client = http_client(300, true)?;

    let resp = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {} downloading yt-dlp", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("Download interrupted: {e}"))?;
    let expected = fetch_expected_hash(download_url).await?;
    check_binary_bytes(&bytes, asset_name_from_url(download_url), &expected)?;

    let part = dest.with_file_name(format!(
        "{}.part",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("yt-dlp")
    ));
    tokio::fs::write(&part, &bytes)
        .await
        .map_err(|e| format!("Cannot write {}: {e}", part.display()))?;

    // Make executable on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&part).await.map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&part, perms).await.map_err(|e| e.to_string())?;
    }

    if let Err(e) = tokio::fs::rename(&part, dest).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(format!(
            "Cannot replace {} (is yt-dlp running?): {e}",
            dest.display()
        ));
    }
    Ok(())
}

// ── Public helpers ────────────────────────────────────────────────────────────

/// Returns `true` if the URL should be downloaded via yt-dlp (YouTube, etc.)
/// rather than the raw HTTP segment engine.
pub fn is_yt_dlp_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    lower.contains("youtube.com/watch")
        || lower.contains("youtube.com/shorts/")
        || lower.contains("youtube.com/live/")
        || lower.contains("youtu.be/")
        || lower.contains("youtube.com/v/")
        || lower.contains("youtube.com/embed/")
        || lower.contains("music.youtube.com/watch")
}

/// Find the yt-dlp executable.  Checks (in order):
/// 1. User-configured path from `ytdlp_path` in config
/// 2. Bundled binary in the Tauri resource directory (shipped with the app)
/// 3. PATH lookup (`yt-dlp` / `yt-dlp.exe`)
/// 4. Common install locations on each platform
pub fn find_yt_dlp(user_path: Option<&str>, resource_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    // 1. User configured path
    if let Some(p) = user_path {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }

    // 2. Bundled binary (shipped inside the installer under the resource dir)
    if let Some(res_dir) = resource_dir {
        let bundled = if cfg!(windows) {
            res_dir.join("yt-dlp.exe")
        } else {
            res_dir.join("yt-dlp")
        };
        if bundled.is_file() {
            log::info!("[yt-dlp] Using bundled binary: {}", bundled.display());
            return Some(bundled);
        }
    }

    // 3. PATH
    let names = if cfg!(windows) {
        vec!["yt-dlp.exe", "yt-dlp"]
    } else {
        vec!["yt-dlp"]
    };

    for name in &names {
        if let Ok(path) = which::which(name) {
            return Some(path);
        }
    }

    // 4. Common install locations
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\yt-dlp\yt-dlp.exe"),
            dirs::data_local_dir()
                .map(|d| d.join("Programs").join("yt-dlp").join("yt-dlp.exe"))
                .unwrap_or_default(),
            dirs::download_dir()
                .map(|d| d.join("yt-dlp.exe"))
                .unwrap_or_default(),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/usr/local/bin/yt-dlp"),
            PathBuf::from("/opt/homebrew/bin/yt-dlp"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/bin/yt-dlp"),
            PathBuf::from("/usr/local/bin/yt-dlp"),
        ]
    };

    candidates.into_iter().find(|p| p.is_file())
}

// ── ffmpeg detection ──────────────────────────────────────────────────────────

/// Returns true if ffmpeg is available (needed for merging video+audio streams).
pub fn has_ffmpeg() -> bool {
    let names: &[&str] = if cfg!(windows) {
        &["ffmpeg.exe", "ffmpeg"]
    } else {
        &["ffmpeg"]
    };
    for name in names {
        if which::which(name).is_ok() {
            return true;
        }
    }
    // Check common locations
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            PathBuf::from(r"C:\ffmpeg\bin\ffmpeg.exe"),
            PathBuf::from(r"C:\Program Files\ffmpeg\bin\ffmpeg.exe"),
            dirs::data_local_dir()
                .map(|d| d.join("Programs").join("ffmpeg").join("bin").join("ffmpeg.exe"))
                .unwrap_or_default(),
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/usr/local/bin/ffmpeg"),
            PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/bin/ffmpeg"),
            PathBuf::from("/usr/local/bin/ffmpeg"),
        ]
    };
    candidates.into_iter().any(|p| p.is_file())
}

/// Returns true if ffmpeg is available at `ffmpeg_dir` OR on the system PATH.
pub fn ffmpeg_available(ffmpeg_dir: Option<&std::path::Path>) -> bool {
    // 1. App-managed binary (highest priority)
    if let Some(dir) = ffmpeg_dir {
        let bin = if cfg!(windows) {
            dir.join("ffmpeg.exe")
        } else {
            dir.join("ffmpeg")
        };
        if bin.is_file() {
            return true;
        }
    }
    // 2. System PATH
    has_ffmpeg()
}

/// Build the yt-dlp `-f` format string for a given quality and ffmpeg availability.
///
/// Quality values: "best" | "1080p" | "720p" | "480p" | "360p" | "audio" | <raw format id>
fn format_for_quality(quality: Option<&str>, ffmpeg: bool) -> (String, bool) {
    // Returns (format_string, is_audio_only)
    let q = quality.unwrap_or("best");
    match q {
        "audio" => ("bestaudio/best".to_string(), true),
        "360p"  => ("bestvideo[height<=360]+bestaudio/best[height<=360]/best".to_string(), false),
        "480p"  => {
            if ffmpeg {
                ("bestvideo[height<=480]+bestaudio/best[height<=480]/best".to_string(), false)
            } else {
                ("best[height<=480]/best".to_string(), false)
            }
        }
        "720p"  => {
            if ffmpeg {
                ("bestvideo[height<=720]+bestaudio/best[height<=720]/best".to_string(), false)
            } else {
                ("best[height<=720]/best".to_string(), false)
            }
        }
        "1080p" => {
            if ffmpeg {
                ("bestvideo[height<=1080]+bestaudio/best[height<=1080]/best".to_string(), false)
            } else {
                ("best[height<=1080]/best".to_string(), false)
            }
        }
        "best"  => {
            if ffmpeg {
                ("bestvideo+bestaudio/best".to_string(), false)
            } else {
                ("best".to_string(), false)
            }
        }
        _ => {
            // Raw format string from list-formats (e.g. "137+bestaudio/best", "18")
            let is_audio = q.starts_with("bestaudio") && !q.contains('+');
            (q.to_string(), is_audio)
        }
    }
}

// ── Format listing ────────────────────────────────────────────────────────────

/// A selectable format option returned by `list_formats`.
#[derive(serde::Serialize, Clone, Debug)]
pub struct FormatOption {
    /// The format string to pass to `-f` (e.g. "137+bestaudio/best" or "18")
    pub format_id: String,
    /// Human label: "1080p", "720p", "Audio only"
    pub label: String,
    /// Detail line: "1920×1080 · mp4 · ~45 MB"
    pub note: String,
    pub height: Option<u32>,
    pub is_audio_only: bool,
    /// Approximate file size in bytes (video only; audio not included for combined formats)
    pub file_size: Option<u64>,
}

/// Result returned by `list_formats`.
#[derive(serde::Serialize, Clone, Debug)]
pub struct FormatResult {
    /// Video title from yt-dlp metadata
    pub title: String,
    pub formats: Vec<FormatOption>,
}

/// Run `yt-dlp -J` (no download) and return a deduplicated list of quality options.
/// Runs without cookies so we see the full format list.
pub async fn list_formats(bin: &PathBuf, url: &str) -> Result<FormatResult, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["--no-playlist", "--no-warnings", "-J", url]);
    #[cfg(windows)] { cmd.creation_flags(0x08000000); }
    let output = cmd.output().await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(stderr.trim().to_string());
    }

    let json: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse yt-dlp JSON: {}", e))?;

    let title = json["title"].as_str().unwrap_or("").to_string();

    let formats = json["formats"].as_array()
        .ok_or_else(|| "No formats in yt-dlp output".to_string())?;

    struct Raw {
        id: String,
        ext: String,
        height: Option<u32>,
        has_video: bool,
        has_audio: bool,
        tbr: f64,
        note: String,
        filesize: Option<u64>,
    }

    let mut raw: Vec<Raw> = Vec::new();
    for f in formats {
        let id = f["format_id"].as_str().unwrap_or("").to_string();
        if id.is_empty() { continue; }

        let ext = f["ext"].as_str().unwrap_or("").to_string();
        let vcodec = f["vcodec"].as_str().unwrap_or("none");
        let acodec = f["acodec"].as_str().unwrap_or("none");
        let has_video = vcodec != "none" && !vcodec.is_empty();
        let has_audio = acodec != "none" && !acodec.is_empty();

        // Skip storyboards, manifests, live fragments
        if !has_video && !has_audio { continue; }
        if matches!(ext.as_str(), "mhtml" | "vtt" | "json3") { continue; }

        let height = f["height"].as_u64().map(|h| h as u32);
        let width  = f["width"].as_u64().map(|w| w as u32);
        let tbr    = f["tbr"].as_f64().unwrap_or(0.0);

        let filesize = f["filesize"].as_u64()
            .or_else(|| f["filesize_approx"].as_u64());
        let size_str = filesize.map(|s| {
            if s >= 1_073_741_824 { format!("~{:.1} GB", s as f64 / 1_073_741_824.0) }
            else if s >= 1_048_576 { format!("~{:.0} MB", s as f64 / 1_048_576.0) }
            else { format!("~{} KB", s / 1_024) }
        });

        let res_str = match (width, height) {
            (Some(w), Some(h)) => format!("{}×{}", w, h),
            (None, Some(h))    => format!("{}p", h),
            _                  => String::new(),
        };

        let note = [
            if res_str.is_empty() { None } else { Some(res_str) },
            if ext.is_empty() { None } else { Some(ext.clone()) },
            size_str,
        ]
        .into_iter().flatten().collect::<Vec<_>>().join(" · ");

        raw.push(Raw { id, ext, height, has_video, has_audio, tbr, note, filesize });
    }

    let mut options: Vec<FormatOption> = Vec::new();

    // Deduplicate by height: pick best video format per height bucket
    let height_buckets: &[u32] = &[4320, 2160, 1440, 1080, 720, 480, 360, 240, 144];
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();

    for &bucket in height_buckets {
        let best = raw.iter()
            .filter(|f| f.has_video && f.height == Some(bucket))
            .max_by(|a, b| a.tbr.partial_cmp(&b.tbr).unwrap_or(std::cmp::Ordering::Equal));

        if let Some(f) = best {
            if seen.insert(bucket) {
                let format_id = if f.has_audio {
                    f.id.clone()
                } else {
                    format!("{}+bestaudio/best", f.id)
                };
                let label = match bucket {
                    4320 => "8K".to_string(),
                    2160 => "4K".to_string(),
                    1440 => "1440p".to_string(),
                    _    => format!("{}p", bucket),
                };
                options.push(FormatOption {
                    format_id,
                    label,
                    note: f.note.clone(),
                    height: Some(bucket),
                    is_audio_only: false,
                    file_size: f.filesize,
                });
            }
        }
    }

    // Audio-only option
    let best_audio = raw.iter()
        .filter(|f| f.has_audio && !f.has_video)
        .max_by(|a, b| a.tbr.partial_cmp(&b.tbr).unwrap_or(std::cmp::Ordering::Equal));
    if let Some(a) = best_audio {
        options.push(FormatOption {
            format_id: format!("{}/bestaudio", a.id),
            label: "Audio only".to_string(),
            note: a.note.clone(),
            height: None,
            is_audio_only: true,
            file_size: a.filesize,
        });
    }

    // Fallback: if nothing matched the height buckets (e.g. combined-only streams),
    // expose every unique video height we found.
    if options.is_empty() || (options.len() == 1 && options[0].is_audio_only) {
        let mut heights: Vec<u32> = raw.iter()
            .filter(|f| f.has_video)
            .filter_map(|f| f.height)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        heights.sort_by(|a, b| b.cmp(a));
        for h in heights {
            if seen.contains(&h) { continue; }
            if let Some(f) = raw.iter()
                .filter(|f| f.has_video && f.height == Some(h))
                .max_by(|a, b| a.tbr.partial_cmp(&b.tbr).unwrap_or(std::cmp::Ordering::Equal))
            {
                let format_id = if f.has_audio { f.id.clone() } else { format!("{}+bestaudio/best", f.id) };
                options.insert(0, FormatOption {
                    format_id,
                    label: format!("{}p", h),
                    note: f.note.clone(),
                    height: Some(h),
                    is_audio_only: false,
                    file_size: f.filesize,
                });
            }
        }
    }

    Ok(FormatResult { title, formats: options })
}

// ── Main download function ────────────────────────────────────────────────────

/// Returns true if the error message indicates a format-not-available failure.
fn is_format_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("requested format is not available")
        || lower.contains("format is not available")
        || lower.contains("no video formats found")
}

/// Run a yt-dlp process with the given args. Returns `Ok((filename, bytes))`
/// on success, or `Err((error_msg, is_format_error))` on failure.
async fn exec_yt_dlp_process(
    yt_dlp_bin: &PathBuf,
    args: Vec<String>,
    item_id: &str,
    state: Arc<Mutex<EngineState>>,
    cancel_token: &CancellationToken,
    app_handle: &tauri::AppHandle,
) -> Result<(String, u64), (String, bool)> {
    let cmd_str = format!("{} {}", yt_dlp_bin.display(), args.join(" "));
    log::info!("[yt-dlp] Running: {}", cmd_str);
    emit_log(app_handle, item_id, "cmd", &cmd_str);

    let mut cmd = tokio::process::Command::new(yt_dlp_bin);
    cmd.args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // Hide the console window on Windows
    #[cfg(windows)]
    { cmd.creation_flags(0x08000000); } // CREATE_NO_WINDOW

    let mut child = cmd.spawn()
        .map_err(|e| (format!("Failed to start yt-dlp: {}", e), false))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let state_prog = Arc::clone(&state);
    let id_prog = item_id.to_string();
    let app_stdout = app_handle.clone();
    let app_stderr = app_handle.clone();

    // Parse stdout for progress and filename
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut last_filename = String::new();
        let mut last_bytes = 0u64;

        while let Ok(Some(line)) = reader.next_line().await {
            emit_log(&app_stdout, &id_prog, "stdout", &line);

            // [download] Destination: /path/to/file.mp4
            if let Some(dest) = line.strip_prefix("[download] Destination: ") {
                last_filename = dest.trim().to_string();
                log::debug!("[yt-dlp] Destination: {}", last_filename);
            }

            // [download] /path/file.mp4 has already been downloaded
            if let Some(rest) = line.strip_prefix("[download] ") {
                if let Some(path) = rest.strip_suffix(" has already been downloaded") {
                    last_filename = path.trim().to_string();
                }
            }

            // [Merger] Merging formats into "file.mp4"
            if let Some(merged) = line.strip_prefix("[Merger] Merging formats into \"") {
                last_filename = merged.trim_end_matches('"').to_string();
            }

            // [download]  45.6% of 12.34MiB at  1.23MiB/s ETA 00:08
            if line.starts_with("[download]") && line.contains('%') {
                if let Some((progress, speed, eta, bytes, total)) = parse_progress_line(&line) {
                    last_bytes = bytes;
                    let mut st = state_prog.lock().await;
                    if let Some(item) = st.downloads.get_mut(&id_prog) {
                        item.progress = progress;
                        item.speed = speed;
                        item.eta = eta;
                        item.downloaded = bytes;
                        // Update file_size as soon as we learn it from yt-dlp progress output
                        if item.file_size <= 0 && total > 0 {
                            item.file_size = total as i64;
                        }
                    }
                }
            }
        }
        (last_filename, last_bytes)
    });

    // Capture stderr for error reporting
    let id_err = item_id.to_string();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut error_lines: Vec<String> = Vec::new();
        while let Ok(Some(line)) = reader.next_line().await {
            if !line.is_empty() {
                log::debug!("[yt-dlp stderr] {}", line);
                emit_log(&app_stderr, &id_err, "stderr", &line);
                if line.contains("ERROR") || line.starts_with("error:") {
                    error_lines.push(line);
                }
            }
        }
        error_lines
    });

    // Wait for completion or cancellation
    let exit_status = tokio::select! {
        _ = cancel_token.cancelled() => {
            child.kill().await.ok();
            return Err(("cancelled".to_string(), false));
        }
        status = child.wait() => {
            status.map_err(|e| (format!("yt-dlp wait error: {}", e), false))?
        }
    };

    let (output_filename, total_bytes) = stdout_task.await.unwrap_or_default();
    let error_lines = stderr_task.await.unwrap_or_default();

    if !exit_status.success() {
        let code = exit_status.code().unwrap_or(-1);
        let detail = error_lines.last().cloned().unwrap_or_default();
        let err_msg = if detail.is_empty() {
            format!("yt-dlp failed (code {})", code)
        } else {
            detail
        };
        let fmt_err = is_format_error(&err_msg);
        return Err((err_msg, fmt_err));
    }

    let file_name = PathBuf::from(&output_filename)
        .file_name()
        .and_then(|n| n.to_str())
        .map(String::from)
        .unwrap_or_else(|| output_filename.clone());

    emit_log(app_handle, item_id, "info", &format!("OK: {}", file_name));
    Ok((file_name, total_bytes))
}

/// Build the base yt-dlp args (everything except cookies and the URL).
fn build_base_args(
    format_str: &str,
    output_template: &str,
    ffmpeg_dir: Option<&PathBuf>,
    ffmpeg: bool,
    is_audio: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--progress".into(),
        "--newline".into(),
        "--no-colors".into(),
        "-f".into(), format_str.to_string(),
        "-o".into(), output_template.to_string(),
    ];

    if let Some(dir) = ffmpeg_dir {
        args.push("--ffmpeg-location".into());
        args.push(dir.to_string_lossy().to_string());
    }

    if ffmpeg {
        if is_audio {
            args.push("--extract-audio".into());
            args.push("--audio-format".into());
            args.push("mp3".into());
        } else {
            args.push("--merge-output-format".into());
            args.push("mp4".into());
        }
    }

    args
}

/// Download a URL using yt-dlp.
///
/// * `yt_dlp_bin`   – path to the yt-dlp executable
/// * `item_id`      – DownloadItem id (for state updates)
/// * `url`          – the page URL (youtube.com/watch?v=...)
/// * `output_dir`   – save directory
/// * `browser`      – browser to extract cookies from ("chrome", "firefox", …)
///                    Pass `None` to skip cookie extraction
/// * `quality`      – "best" | "1080p" | "720p" | "480p" | "360p" | "audio"
///                    Pass `None` for best quality
/// * `ffmpeg_dir`   – directory containing the managed ffmpeg binary; if `Some`
///                    yt-dlp is told to use it via `--ffmpeg-location`
/// * `cancel_token` – cancelled on pause/stop
/// * `state`        – shared engine state (updated with progress)
///
/// Returns `Ok((file_name, total_bytes))` on success.
pub async fn run_yt_dlp(
    yt_dlp_bin: PathBuf,
    item_id: String,
    url: String,
    output_dir: String,
    cookie: Option<String>,
    quality: Option<String>,
    ffmpeg_dir: Option<PathBuf>,
    cookies_file: Option<std::path::PathBuf>,
    cancel_token: CancellationToken,
    state: Arc<Mutex<EngineState>>,
    app_handle: tauri::AppHandle,
) -> Result<(String, u64), String> {
    let ffmpeg = ffmpeg_available(ffmpeg_dir.as_deref());
    let (format_str, is_audio) = format_for_quality(quality.as_deref(), ffmpeg);

    log::info!(
        "[yt-dlp] ffmpeg={} ffmpeg_dir={:?} quality={:?} format={}",
        ffmpeg, ffmpeg_dir, quality, format_str
    );

    let output_template = format!("{}/%(title).200B.%(ext)s", output_dir);
    let has_cookies = cookies_file.is_some() || cookie.as_ref().map_or(false, |c| !c.is_empty());

    // Build args with cookies
    let mut args = build_base_args(&format_str, &output_template, ffmpeg_dir.as_ref(), ffmpeg, is_audio);

    // Cookie priority: Netscape file (from extension) > plain cookie header.
    // Extension provides cookies — no browser extraction needed.
    if let Some(ref file) = cookies_file {
        args.push("--cookies".into());
        args.push(file.to_string_lossy().into_owned());
    } else if let Some(ref c) = cookie {
        if !c.is_empty() {
            args.push("--add-headers".into());
            args.push(format!("Cookie:{}", c));
        }
    }

    args.push(url.clone());

    match exec_yt_dlp_process(&yt_dlp_bin, args, &item_id, Arc::clone(&state), &cancel_token, &app_handle).await {
        Ok(result) => return Ok(result),
        Err((err_msg, is_fmt_err)) if is_fmt_err && has_cookies => {
            // YouTube sometimes returns a restricted format list when cookies are
            // present (e.g. wrong region, age-gate state). Retry without cookies.
            emit_log(&app_handle, &item_id, "info",
                &format!("Format error with cookies ({}), retrying without cookies…", err_msg));
            log::warn!("[yt-dlp] Format error with cookies, retrying without: {}", err_msg);

            let mut retry_args = build_base_args(&format_str, &output_template, ffmpeg_dir.as_ref(), ffmpeg, is_audio);
            retry_args.push(url.clone());

            exec_yt_dlp_process(&yt_dlp_bin, retry_args, &item_id, state, &cancel_token, &app_handle)
                .await
                .map_err(|(msg, _)| {
                    emit_log(&app_handle, &item_id, "error", &format!("FAILED: {}", msg));
                    msg
                })
        }
        Err((err_msg, _)) => {
            emit_log(&app_handle, &item_id, "error", &format!("FAILED: {}", err_msg));
            Err(err_msg)
        }
    }
}

// ── Progress parser ───────────────────────────────────────────────────────────

/// Parse a yt-dlp progress line:
/// `[download]  45.6% of   12.34MiB at    1.23MiB/s ETA 00:08`
///
/// Returns `(progress%, speed_bytes/s, eta_secs, downloaded_bytes, total_bytes)`.
fn parse_progress_line(line: &str) -> Option<(f64, f64, i64, u64, u64)> {
    // Extract percentage
    let pct_end = line.find('%')?;
    let pct_start = line[..pct_end].rfind(|c: char| c.is_whitespace())? + 1;
    let pct: f64 = line[pct_start..pct_end].trim().parse().ok()?;

    // Extract total size from "of X.XXMiB"
    let total_bytes = if let Some(of_pos) = line.find(" of ") {
        let after = &line[of_pos + 4..];
        let size_end = after.find(|c: char| c.is_whitespace()).unwrap_or(after.len());
        parse_size_str(&after[..size_end]).unwrap_or(0)
    } else {
        0
    };

    let downloaded = if total_bytes > 0 && pct > 0.0 {
        (total_bytes as f64 * pct / 100.0) as u64
    } else {
        0
    };

    // Extract speed from "at X.XXMiB/s"
    let speed = if let Some(at_pos) = line.find(" at ") {
        let after = &line[at_pos + 4..];
        let end = after.find("/s").unwrap_or(after.len());
        let speed_part = after[..end].trim();
        parse_size_str(speed_part).unwrap_or(0) as f64
    } else {
        0.0
    };

    // Extract ETA from "ETA HH:MM" or "ETA MM:SS"
    let eta = if let Some(eta_pos) = line.find("ETA ") {
        let after = &line[eta_pos + 4..];
        let end = after.find(|c: char| c.is_whitespace() || c == '\n').unwrap_or(after.len());
        parse_eta_str(&after[..end]).unwrap_or(0)
    } else {
        0
    };

    Some((pct, speed, eta, downloaded, total_bytes))
}

/// Parse a human-readable size string like "12.34MiB", "567KiB", "1.2GiB", "890B"
fn parse_size_str(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num_str, unit) = if let Some(pos) = s.find(|c: char| c.is_alphabetic()) {
        (&s[..pos], &s[pos..])
    } else {
        return s.parse::<u64>().ok();
    };
    let num: f64 = num_str.parse().ok()?;
    let multiplier = match unit.to_uppercase().as_str() {
        "GIB" | "GB" => 1_073_741_824.0,
        "MIB" | "MB" => 1_048_576.0,
        "KIB" | "KB" => 1_024.0,
        "B"          => 1.0,
        _            => return None,
    };
    Some((num * multiplier) as u64)
}

/// Parse "MM:SS" or "HH:MM:SS" into total seconds.
fn parse_eta_str(s: &str) -> Option<i64> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        2 => {
            let m: i64 = parts[0].parse().ok()?;
            let s: i64 = parts[1].parse().ok()?;
            Some(m * 60 + s)
        }
        3 => {
            let h: i64 = parts[0].parse().ok()?;
            let m: i64 = parts[1].parse().ok()?;
            let s: i64 = parts[2].parse().ok()?;
            Some(h * 3600 + m * 60 + s)
        }
        _ => None,
    }
}

#[cfg(test)]
mod release_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const OK_BODY: &str = r#"{"tag_name":"2025.01.15","assets":[
        {"name":"yt-dlp","browser_download_url":"https://github.com/yt-dlp/yt-dlp/releases/download/2025.01.15/yt-dlp"},
        {"name":"yt-dlp.exe","browser_download_url":"https://github.com/yt-dlp/yt-dlp/releases/download/2025.01.15/yt-dlp.exe"}]}"#;

    #[test]
    fn parses_good_release_for_windows_asset() {
        let (tag, url) = parse_latest_release(200, None, OK_BODY, "yt-dlp.exe").unwrap();
        assert_eq!(tag, "2025.01.15");
        assert!(url.ends_with("/2025.01.15/yt-dlp.exe"));
    }

    #[test]
    fn rate_limit_is_reported_clearly_not_as_missing_tag() {
        let body = r#"{"message":"API rate limit exceeded for 1.2.3.4.","documentation_url":"x"}"#;
        let e = parse_latest_release(403, Some("0"), body, "yt-dlp.exe").unwrap_err();
        assert!(e.contains("rate limit"), "{e}");
        assert!(!e.contains("No tag_name"));
        assert!(parse_latest_release(429, None, "{}", "yt-dlp.exe").unwrap_err().contains("rate limit"));
    }

    #[test]
    fn http_errors_include_status_and_api_message() {
        let e = parse_latest_release(404, None, r#"{"message":"Not Found"}"#, "yt-dlp.exe").unwrap_err();
        assert!(e.contains("404") && e.contains("Not Found"), "{e}");
        let e = parse_latest_release(502, None, "<html>Bad gateway</html>", "yt-dlp.exe").unwrap_err();
        assert!(e.contains("502"), "{e}");
    }

    #[test]
    fn missing_or_empty_tag_and_bad_json_are_errors() {
        assert!(parse_latest_release(200, None, r#"{"assets":[]}"#, "yt-dlp.exe").unwrap_err().contains("no tag_name"));
        assert!(parse_latest_release(200, None, r#"{"tag_name":"  ","assets":[]}"#, "yt-dlp.exe").unwrap_err().contains("no tag_name"));
        assert!(parse_latest_release(200, None, "not json", "yt-dlp.exe").unwrap_err().contains("non-JSON"));
        assert!(parse_latest_release(200, None, r#"{"tag_name":"../evil","assets":[]}"#, "yt-dlp.exe").is_err());
    }

    #[test]
    fn missing_asset_or_foreign_host_rejected() {
        let e = parse_latest_release(200, None, r#"{"tag_name":"1","assets":[]}"#, "yt-dlp.exe").unwrap_err();
        assert!(e.contains("not found"), "{e}");
        let evil = r#"{"tag_name":"1","assets":[{"name":"yt-dlp.exe","browser_download_url":"https://evil.example/yt-dlp.exe"}]}"#;
        assert!(parse_latest_release(200, None, evil, "yt-dlp.exe").unwrap_err().contains("unexpected download host"));
    }

    #[test]
    fn redirect_location_tag_parsing() {
        assert_eq!(tag_from_location("https://github.com/yt-dlp/yt-dlp/releases/tag/2025.01.15").as_deref(), Some("2025.01.15"));
        assert_eq!(tag_from_location("/yt-dlp/yt-dlp/releases/tag/2025.01.15/").as_deref(), Some("2025.01.15"));
        assert!(tag_from_location("https://github.com/login").is_none());
    }

    #[test]
    fn sha256sums_parsing() {
        let h = "a".repeat(64);
        let txt = format!("{h}  yt-dlp\n{}  yt-dlp.exe\nbad  yt-dlp_x\n", "B".repeat(64));
        assert_eq!(parse_sha256sums(&txt, "yt-dlp").unwrap(), h);
        assert_eq!(parse_sha256sums(&txt, "yt-dlp.exe").unwrap(), "b".repeat(64));
        assert!(parse_sha256sums(&txt, "yt-dlp_x").is_none());
        assert!(parse_sha256sums(&txt, "missing").is_none());
    }

    #[test]
    fn binary_validation_rejects_bad_downloads() {
        use sha2::{Digest, Sha256};
        let mut good = vec![0u8; MIN_BINARY_BYTES + 10];
        good[0] = b'M';
        good[1] = b'Z';
        let h = hex::encode(Sha256::digest(&good));
        assert!(check_binary_bytes(&good, "yt-dlp.exe", &h).is_ok());
        assert!(check_binary_bytes(&good, "yt-dlp.exe", &"0".repeat(64)).unwrap_err().contains("Checksum mismatch"));
        assert!(check_binary_bytes(b"<html>rate limited</html>", "yt-dlp.exe", &h).unwrap_err().contains("not a valid"));
        let mut not_exe = good.clone();
        not_exe[0] = b'X';
        let h2 = hex::encode(Sha256::digest(&not_exe));
        assert!(check_binary_bytes(&not_exe, "yt-dlp.exe", &h2).unwrap_err().contains("not a Windows executable"));
    }

    /// Minimal one-shot-per-connection HTTP server: maps request path → raw response.
    async fn mock_server(routes: Vec<(&'static str, String)>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };
                let routes = routes.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let resp = routes
                        .iter()
                        .find(|(p, _)| *p == path)
                        .map(|(_, r)| r.clone())
                        .unwrap_or_else(|| "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string());
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn json_resp(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn api_success_over_http() {
        let base = mock_server(vec![("/api", json_resp("200 OK", OK_BODY))]).await;
        let (tag, url) = get_latest_release_from(&format!("{base}/api"), &format!("{base}/latest"), &format!("{base}/dl"), "yt-dlp.exe").await.unwrap();
        assert_eq!(tag, "2025.01.15");
        assert!(url.starts_with("https://github.com/yt-dlp/yt-dlp/"));
    }

    #[tokio::test]
    async fn rate_limited_api_falls_back_to_redirect() {
        let limited = json_resp("403 Forbidden", r#"{"message":"API rate limit exceeded"}"#);
        let redirect = "HTTP/1.1 302 Found\r\nLocation: https://github.com/yt-dlp/yt-dlp/releases/tag/2025.02.01\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string();
        let base = mock_server(vec![("/api", limited), ("/latest", redirect)]).await;
        let dl = format!("{base}/dl");
        let (tag, url) = get_latest_release_from(&format!("{base}/api"), &format!("{base}/latest"), &dl, "yt-dlp.exe").await.unwrap();
        assert_eq!(tag, "2025.02.01");
        assert_eq!(url, format!("{dl}/2025.02.01/yt-dlp.exe"));
    }

    #[tokio::test]
    async fn api_without_tag_name_falls_back_and_both_failures_are_reported() {
        let base = mock_server(vec![("/api", json_resp("200 OK", r#"{"message":"Moved"}"#))]).await;
        let e = get_latest_release_from(&format!("{base}/api"), &format!("{base}/latest"), &format!("{base}/dl"), "yt-dlp.exe").await.unwrap_err();
        assert!(e.contains("no tag_name") && e.contains("Fallback"), "{e}");
    }
}
