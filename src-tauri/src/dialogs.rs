//! Standalone desktop windows: the IDM-style "File Download" information dialog that is shown when
//! a browser extension hands NetGuard a download, and the per-download progress window.
//!
//! Security: the pending request (URL, cookies, auth headers) lives only in this process's memory.
//! The webview gets an opaque random id in its URL and fetches display data through commands, so
//! no credentials ever appear in a window URL, history or log.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::download_engine::{category_subfolder_name, get_category};
use crate::types::*;
use crate::AppState;

/// A second capture of the same URL inside this window (browser fires several events for one
/// click, or a service worker restarts and replays) is ignored once the first was handled.
const DUPLICATE_WINDOW: Duration = Duration::from_secs(8);

/// URLs whose dialog was handled (started, queued or cancelled) a moment ago.
#[derive(Default)]
pub struct RecentUrls(HashMap<String, Instant>);

impl RecentUrls {
    pub fn mark(&mut self, url: &str, now: Instant) {
        self.0.retain(|_, t| now.saturating_duration_since(*t) < DUPLICATE_WINDOW);
        self.0.insert(url.to_string(), now);
    }
    pub fn seen_recently(&self, url: &str, now: Instant) -> bool {
        self.0
            .get(url)
            .map(|t| now.saturating_duration_since(*t) < DUPLICATE_WINDOW)
            .unwrap_or(false)
    }
}

/// Folder shown in the dialog: the folder remembered for the category, otherwise
/// `<download dir>/NetGuard/<Category>` (the same layout the engine uses by default).
pub fn resolve_save_dir(download_dir: &str, subfolder: &str, remembered: Option<&str>) -> String {
    match remembered.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => r.to_string(),
        None => PathBuf::from(download_dir)
            .join("NetGuard")
            .join(subfolder)
            .to_string_lossy()
            .to_string(),
    }
}

fn category_key(cat: &DownloadCategory) -> String {
    serde_json::to_value(cat)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "other".to_string())
}

fn remembered_paths_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("category_paths.json"))
}

fn load_remembered_paths(app: &AppHandle) -> HashMap<String, String> {
    remembered_paths_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn remember_path_for(app: &AppHandle, category: &str, dir: &str) {
    let mut map = load_remembered_paths(app);
    map.insert(category.to_string(), dir.to_string());
    if let Some(file) = remembered_paths_file(app) {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        if let Ok(json) = serde_json::to_string_pretty(&map) {
            if let Err(e) = std::fs::write(&file, json) {
                log::warn!("[dialog] could not save category paths: {e}");
            }
        }
    }
}

#[derive(Clone)]
pub struct PendingDownload {
    pub url: String,
    pub file_name: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub source_page_url: Option<String>,
    pub ytdlp_cookies: Option<String>,
}

#[derive(Default)]
pub struct PendingDialogs(pub Mutex<HashMap<String, PendingDownload>>, pub Mutex<RecentUrls>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInfo {
    pub url: String,
    pub file_name: String,
    /// -1 when the server did not report a size.
    pub file_size: i64,
    pub resumable: bool,
    /// Default base folder (downloads are sorted into a category sub-folder unless overridden).
    pub default_dir: String,
    pub error: Option<String>,
    /// Engine category key ("videos", "compressed", ...) and its display label.
    pub category: String,
    pub category_label: String,
    /// Folder the file will be saved to unless the user changes it.
    pub save_dir: String,
    /// True when `save_dir` is a folder the user asked to remember for this category.
    pub remembered: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub category: String,
    pub category_label: String,
    pub save_dir: String,
    pub remembered: bool,
}

fn category_info_for(app: &AppHandle, download_dir: &str, file_name: &str) -> CategoryInfo {
    let cat = get_category(file_name);
    let key = category_key(&cat);
    let label = category_subfolder_name(&cat).to_string();
    let remembered = load_remembered_paths(app).get(&key).cloned();
    CategoryInfo {
        save_dir: resolve_save_dir(download_dir, &label, remembered.as_deref()),
        remembered: remembered.as_deref().map(|r| !r.trim().is_empty()).unwrap_or(false),
        category: key,
        category_label: label,
    }
}

fn dialog_label(id: &str) -> String { format!("dlinfo-{id}") }
fn progress_label(id: &str) -> String { format!("progress-{id}") }

fn focus(app: &AppHandle, label: &str) -> bool {
    if let Some(w) = app.get_webview_window(label) {
        w.show().ok();
        w.unminimize().ok();
        w.set_focus().ok();
        true
    } else {
        false
    }
}

/// Show the information dialog for a browser-captured download. A request for a URL that already
/// has an open dialog just focuses it (no duplicate dialogs from repeated interception).
pub fn open_download_dialog(app: &AppHandle, pending: PendingDownload) -> Result<(), String> {
    let store = app.state::<PendingDialogs>();
    let id = {
        let mut map = store.0.lock().unwrap();
        if let Some(existing) = map.iter().find(|(_, p)| p.url == pending.url).map(|(k, _)| k.clone()) {
            drop(map);
            focus(app, &dialog_label(&existing));
            return Ok(());
        }
        if store.1.lock().unwrap().seen_recently(&pending.url, Instant::now()) {
            return Ok(()); // duplicate event for a download that was just handled
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        map.insert(id.clone(), pending);
        id
    };

    let url = WebviewUrl::App(format!("index.html?view=dlinfo&id={id}").into());
    let built = WebviewWindowBuilder::new(app, dialog_label(&id), url)
        .title("NetGuard Download Manager - File Download")
        .inner_size(620.0, 560.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .always_on_top(true)
        .focused(true)
        .build();

    match built {
        Ok(win) => {
            let app2 = app.clone();
            let id2 = id.clone();
            win.on_window_event(move |e| {
                // Closing the dialog with the X button == Cancel.
                if let WindowEvent::Destroyed = e {
                    let st = app2.state::<PendingDialogs>();
                    let removed = st.0.lock().unwrap().remove(&id2);
                    if let Some(p) = removed {
                        st.1.lock().unwrap().mark(&p.url, Instant::now());
                    }
                }
            });
            Ok(())
        }
        Err(e) => {
            store.0.lock().unwrap().remove(&id);
            Err(format!("could not open download dialog: {e}"))
        }
    }
}

pub fn open_progress_window(app: &AppHandle, download_id: &str) {
    let label = progress_label(download_id);
    if focus(app, &label) {
        return;
    }
    let url = WebviewUrl::App(format!("index.html?view=progress&id={download_id}").into());
    if let Err(e) = WebviewWindowBuilder::new(app, label, url)
        .title("NetGuard Download Manager - Downloading")
        .inner_size(540.0, 380.0)
        .resizable(false)
        .maximizable(false)
        .center()
        .focused(true)
        .build()
    {
        log::error!("[dialog] could not open progress window: {e}");
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn dialog_pending_get(
    app: AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, PendingDialogs>,
    id: String,
) -> Result<PendingInfo, String> {
    let p = { pending.0.lock().unwrap().get(&id).cloned() }
        .ok_or_else(|| "This download request is no longer pending".to_string())?;
    let default_dir = state.engine.config.lock().await.download_dir.clone();

    // Real probe: follows redirects, reports size / resumability / server-provided file name.
    let probe = state.engine.probe_url(&p.url, p.headers.as_ref()).await;
    let (file_size, resumable, probed_name, error) = match probe {
        Ok(r) => (r.file_size, r.resumable, r.file_name, None),
        Err(e) => (-1, false, String::new(), Some(e)),
    };
    let file_name = p
        .file_name
        .clone()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(probed_name);
    let cat = category_info_for(&app, &default_dir, &file_name);
    Ok(PendingInfo {
        url: p.url,
        file_name,
        file_size,
        resumable,
        default_dir,
        error,
        category: cat.category,
        category_label: cat.category_label,
        save_dir: cat.save_dir,
        remembered: cat.remembered,
    })
}

/// Category + target folder for a (possibly edited) file name.
#[tauri::command]
pub async fn dialog_category_info(
    app: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
) -> Result<CategoryInfo, String> {
    let dir = state.engine.config.lock().await.download_dir.clone();
    Ok(category_info_for(&app, &dir, &file_name))
}

#[tauri::command]
pub async fn dialog_pending_confirm(
    app: AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, PendingDialogs>,
    id: String,
    file_name: Option<String>,
    save_dir: Option<String>,
    start_now: bool,
    description: Option<String>,
    remember_path: Option<bool>,
) -> Result<DownloadItem, String> {
    let p = { pending.0.lock().unwrap().remove(&id) }
        .ok_or_else(|| "This download request is no longer pending".to_string())?;
    let handled_url = p.url.clone();
    let save_dir = save_dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mut item = state
        .engine
        .add_download(NewDownloadRequest {
            url: p.url,
            file_name: file_name.filter(|s| !s.trim().is_empty()).or(p.file_name),
            save_path: save_dir.clone(),
            headers: p.headers,
            max_segments: None,
            auto_start: Some(start_now),
            source_page_url: p.source_page_url,
            ytdlp_quality: None,
            ytdlp_cookies: p.ytdlp_cookies,
            expected_sha256: None,
        })
        .await?;
    pending.1.lock().unwrap().mark(&handled_url, Instant::now());

    let description = description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    if description.is_some() {
        state.engine.set_description(&item.id, description.clone()).await;
        item.description = description;
    }
    if remember_path.unwrap_or(false) {
        if let Some(dir) = &save_dir {
            remember_path_for(&app, &category_key(&item.category), dir);
        }
    }

    if let Some(w) = app.get_webview_window(&dialog_label(&id)) {
        w.close().ok();
    }
    if start_now {
        open_progress_window(&app, &item.id);
    }
    Ok(item)
}

#[tauri::command]
pub async fn dialog_pending_cancel(
    app: AppHandle,
    pending: State<'_, PendingDialogs>,
    id: String,
) -> Result<(), String> {
    let removed = pending.0.lock().unwrap().remove(&id);
    if let Some(p) = removed {
        pending.1.lock().unwrap().mark(&p.url, Instant::now());
    }
    if let Some(w) = app.get_webview_window(&dialog_label(&id)) {
        w.close().ok();
    }
    Ok(())
}

#[tauri::command]
pub async fn progress_window_open(app: AppHandle, id: String) -> Result<(), String> {
    open_progress_window(&app, &id);
    Ok(())
}

#[tauri::command]
pub async fn progress_window_close(app: AppHandle, id: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&progress_label(&id)) {
        w.close().ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_window_suppresses_repeat_then_expires() {
        let t0 = Instant::now();
        let mut r = RecentUrls::default();
        assert!(!r.seen_recently("https://a/x.zip", t0));
        r.mark("https://a/x.zip", t0);
        assert!(r.seen_recently("https://a/x.zip", t0 + Duration::from_secs(2)));
        assert!(!r.seen_recently("https://a/other.zip", t0 + Duration::from_secs(2)));
        assert!(!r.seen_recently("https://a/x.zip", t0 + DUPLICATE_WINDOW + Duration::from_secs(1)));
    }

    #[test]
    fn save_dir_prefers_remembered_folder() {
        let d = resolve_save_dir("C:\\Users\\u\\Downloads", "Video", None);
        assert!(d.ends_with("Video") && d.contains("NetGuard"), "{d}");
        assert_eq!(resolve_save_dir("C:\\dl", "Video", Some("D:\\Movies")), "D:\\Movies");
        // blank remembered value falls back to the default layout
        assert!(resolve_save_dir("C:\\dl", "Music", Some("  ")).ends_with("Music"));
    }

    #[test]
    fn category_key_matches_frontend_names() {
        assert_eq!(category_key(&get_category("movie.mp4")), "videos");
        assert_eq!(category_key(&get_category("setup.exe")), "programs");
        assert_eq!(category_key(&get_category("a.zip")), "compressed");
        assert_eq!(category_key(&get_category("noext")), "other");
    }
}
