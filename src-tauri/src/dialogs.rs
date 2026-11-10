//! Standalone desktop windows: the IDM-style "File Download" information dialog that is shown when
//! a browser extension hands NetGuard a download, and the per-download progress window.
//!
//! Security: the pending request (URL, cookies, auth headers) lives only in this process's memory.
//! The webview gets an opaque random id in its URL and fetches display data through commands, so
//! no credentials ever appear in a window URL, history or log.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::types::*;
use crate::AppState;

#[derive(Clone)]
pub struct PendingDownload {
    pub url: String,
    pub file_name: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub source_page_url: Option<String>,
    pub ytdlp_cookies: Option<String>,
}

#[derive(Default)]
pub struct PendingDialogs(pub Mutex<HashMap<String, PendingDownload>>);

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
pub fn open_download_dialog(app: &AppHandle, pending: PendingDownload) {
    let store = app.state::<PendingDialogs>();
    let id = {
        let mut map = store.0.lock().unwrap();
        if let Some(existing) = map.iter().find(|(_, p)| p.url == pending.url).map(|(k, _)| k.clone()) {
            drop(map);
            focus(app, &dialog_label(&existing));
            return;
        }
        let id = uuid::Uuid::new_v4().simple().to_string();
        map.insert(id.clone(), pending);
        id
    };

    let url = WebviewUrl::App(format!("index.html?view=dlinfo&id={id}").into());
    let built = WebviewWindowBuilder::new(app, dialog_label(&id), url)
        .title("NetGuard Download Manager - File Download")
        .inner_size(600.0, 430.0)
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
                    app2.state::<PendingDialogs>().0.lock().unwrap().remove(&id2);
                }
            });
        }
        Err(e) => {
            log::error!("[dialog] could not open download dialog: {e}");
            store.0.lock().unwrap().remove(&id);
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
    Ok(PendingInfo { url: p.url, file_name, file_size, resumable, default_dir, error })
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
) -> Result<DownloadItem, String> {
    let p = { pending.0.lock().unwrap().remove(&id) }
        .ok_or_else(|| "This download request is no longer pending".to_string())?;
    let item = state
        .engine
        .add_download(NewDownloadRequest {
            url: p.url,
            file_name: file_name.filter(|s| !s.trim().is_empty()).or(p.file_name),
            save_path: save_dir.filter(|s| !s.trim().is_empty()),
            headers: p.headers,
            max_segments: None,
            auto_start: Some(start_now),
            source_page_url: p.source_page_url,
            ytdlp_quality: None,
            ytdlp_cookies: p.ytdlp_cookies,
            expected_sha256: None,
        })
        .await?;
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
    pending.0.lock().unwrap().remove(&id);
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
