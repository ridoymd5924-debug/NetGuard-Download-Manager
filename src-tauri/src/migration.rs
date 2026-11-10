//! One-way, **copy-only** migration of existing Quantum Download Manager (QDM) user data.
//!
//! Guarantees:
//! * QDM files are never modified, moved or deleted. Everything is copied.
//! * NetGuard files are never overwritten: if NetGuard already has its own config/state the
//!   corresponding step is skipped.
//! * Files are written under a temporary name and renamed, and `downloads.json` (the file the
//!   engine reads) is copied *last*, so a crash half-way never leaves NetGuard with a state file
//!   that points at segments that were not copied yet. Retrying on the next launch is safe.
//! * Any error is reported and logged by the caller; it never prevents the application from
//!   starting.
//!
//! Legacy layout that is recognised (copied from the QDM 1.0.3 conventions):
//! * settings: `<app config dir of QDM>/config.json` — located by scanning the sibling folders of
//!   NetGuard's own config folder (normally `%APPDATA%`) for a folder whose name contains `qdm` or
//!   `quantum`, because the exact bundle identifier QDM used is not hard-coded.
//! * download state: `<download dir>/.qdm_data/` (`downloads.json`, `queues.json`, one folder of
//!   `.part` files per unfinished download).

use std::fs;
use std::path::{Path, PathBuf};

pub const LEGACY_DATA_DIR: &str = ".qdm_data";
pub const NEW_DATA_DIR: &str = ".netguard_data";
pub const MARKER_FILE: &str = ".migrated-from-qdm";

/// Unfinished-download folders larger than this are not duplicated on disk. The engine
/// reconciles with what is really on disk, so such a download simply restarts from the
/// beginning instead of resuming — nothing is lost and nothing is corrupted.
const MAX_PARTIAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DataReport {
    pub migrated: bool,
    pub files_copied: usize,
    pub partial_dirs_skipped_too_large: usize,
}

fn looks_like_qdm_dir(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("qdm") || n.contains("quantum")
}

/// Find QDM's `config.json` next to NetGuard's own config folder.
pub fn find_legacy_config(new_config_dir: &Path) -> Option<PathBuf> {
    let parent = new_config_dir.parent()?;
    let own = new_config_dir.file_name()?.to_owned();
    for entry in fs::read_dir(parent).ok()?.flatten() {
        if entry.file_name() == own {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !looks_like_qdm_dir(&name) {
            continue;
        }
        let cfg = entry.path().join("config.json");
        if cfg.is_file() {
            return Some(cfg);
        }
    }
    None
}

fn write_atomically(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("migrating.tmp");
    fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Copy QDM's settings to `new_config_path` if NetGuard has no settings yet.
/// Returns `Ok(true)` when something was migrated.
pub fn migrate_config(new_config_path: &Path) -> Result<bool, String> {
    if new_config_path.exists() {
        return Ok(false);
    }
    let dir = match new_config_path.parent() {
        Some(d) => d,
        None => return Ok(false),
    };
    let legacy = match find_legacy_config(dir) {
        Some(p) => p,
        None => return Ok(false),
    };
    let text = fs::read_to_string(&legacy).map_err(|e| format!("read {}: {e}", legacy.display()))?;
    let mut json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("QDM config is not valid JSON: {e}"))?;
    if let Some(obj) = json.as_object_mut() {
        // Never switch on login-startup because of a QDM setting: that is an explicit opt-in.
        obj.remove("startWithWindows");
    } else {
        return Err("QDM config.json is not a JSON object".to_string());
    }
    let out = serde_json::to_vec_pretty(&json).map_err(|e| e.to_string())?;
    write_atomically(new_config_path, &out)?;
    Ok(true)
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(path) {
        for e in rd.flatten() {
            match e.metadata() {
                Ok(m) if m.is_dir() => total += dir_size(&e.path()),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    total
}

/// Recursively copy `src` into `dst` without overwriting existing files. Returns files copied.
fn copy_dir_no_overwrite(src: &Path, dst: &Path) -> Result<usize, String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut n = 0usize;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            n += copy_dir_no_overwrite(&from, &to)?;
        } else if !to.exists() {
            fs::copy(&from, &to).map_err(|e| format!("copy {}: {e}", from.display()))?;
            n += 1;
        }
    }
    Ok(n)
}

/// Copy QDM's download state from `<download_dir>/.qdm_data` to `<download_dir>/.netguard_data`.
pub fn migrate_data(download_dir: &Path) -> Result<DataReport, String> {
    let old = download_dir.join(LEGACY_DATA_DIR);
    let new = download_dir.join(NEW_DATA_DIR);
    let mut report = DataReport::default();

    if !old.is_dir() || new.join(MARKER_FILE).exists() || new.join("downloads.json").exists() {
        return Ok(report); // nothing to do, already migrated, or NetGuard has its own state
    }
    fs::create_dir_all(&new).map_err(|e| e.to_string())?;

    // 1. Per-download segment folders (the .part files) — before any state file.
    for entry in fs::read_dir(&old).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if dir_size(&path) > MAX_PARTIAL_BYTES {
            report.partial_dirs_skipped_too_large += 1;
            continue;
        }
        report.files_copied += copy_dir_no_overwrite(&path, &new.join(entry.file_name()))?;
    }

    // 2. queues.json, 3. downloads.json LAST.
    for name in ["queues.json", "downloads.json"] {
        let src = old.join(name);
        if src.is_file() {
            let bytes = fs::read(&src).map_err(|e| format!("read {}: {e}", src.display()))?;
            // Refuse to import something that is not valid JSON instead of poisoning NetGuard.
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|e| format!("{name} is not valid JSON: {e}"))?;
            write_atomically(&new.join(name), &bytes)?;
            report.files_copied += 1;
        }
    }

    fs::write(
        new.join(MARKER_FILE),
        format!(
            "Copied from {} on {}. The original QDM data was left untouched.\n",
            old.display(),
            chrono::Utc::now().to_rfc3339()
        ),
    )
    .map_err(|e| e.to_string())?;
    report.migrated = true;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_tmp(tag: &str) -> PathBuf {
        let t = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!("ng-mig-{tag}-{}-{t}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn data_is_copied_and_original_left_untouched() {
        let dl = unique_tmp("data");
        let old = dl.join(LEGACY_DATA_DIR);
        fs::create_dir_all(old.join("abc123")).unwrap();
        fs::write(old.join("abc123").join("seg1.part"), b"partial-bytes").unwrap();
        fs::write(old.join("downloads.json"), b"[]").unwrap();
        fs::write(old.join("queues.json"), b"[]").unwrap();

        let r = migrate_data(&dl).unwrap();
        assert!(r.migrated);
        assert_eq!(r.files_copied, 3);

        let new = dl.join(NEW_DATA_DIR);
        assert_eq!(fs::read(new.join("abc123").join("seg1.part")).unwrap(), b"partial-bytes");
        assert!(new.join("downloads.json").is_file());
        assert!(new.join(MARKER_FILE).is_file());
        // original is untouched
        assert_eq!(fs::read(old.join("abc123").join("seg1.part")).unwrap(), b"partial-bytes");
        assert!(old.join("downloads.json").is_file());

        // idempotent: second run does nothing
        assert_eq!(migrate_data(&dl).unwrap(), DataReport::default());
        fs::remove_dir_all(&dl).ok();
    }

    #[test]
    fn existing_netguard_state_is_never_overwritten() {
        let dl = unique_tmp("keep");
        fs::create_dir_all(dl.join(LEGACY_DATA_DIR)).unwrap();
        fs::write(dl.join(LEGACY_DATA_DIR).join("downloads.json"), b"[\"old\"]").unwrap();
        fs::create_dir_all(dl.join(NEW_DATA_DIR)).unwrap();
        fs::write(dl.join(NEW_DATA_DIR).join("downloads.json"), b"[\"mine\"]").unwrap();

        assert_eq!(migrate_data(&dl).unwrap(), DataReport::default());
        assert_eq!(fs::read(dl.join(NEW_DATA_DIR).join("downloads.json")).unwrap(), b"[\"mine\"]");
        fs::remove_dir_all(&dl).ok();
    }

    #[test]
    fn invalid_legacy_json_is_rejected_without_creating_state() {
        let dl = unique_tmp("bad");
        fs::create_dir_all(dl.join(LEGACY_DATA_DIR)).unwrap();
        fs::write(dl.join(LEGACY_DATA_DIR).join("downloads.json"), b"{not json").unwrap();

        assert!(migrate_data(&dl).is_err());
        assert!(!dl.join(NEW_DATA_DIR).join("downloads.json").exists());
        assert!(!dl.join(NEW_DATA_DIR).join(MARKER_FILE).exists(), "must retry next launch");
        fs::remove_dir_all(&dl).ok();
    }

    #[test]
    fn config_is_found_by_name_and_startup_flag_is_dropped() {
        let appdata = unique_tmp("cfg");
        let new_dir = appdata.join("com.netguard.downloadmanager");
        let old_dir = appdata.join("com.qdm.app");
        fs::create_dir_all(&old_dir).unwrap();
        fs::create_dir_all(appdata.join("Unrelated")).unwrap();
        fs::write(
            old_dir.join("config.json"),
            br#"{"downloadDir":"D:\\dl","startWithWindows":true,"theme":"light"}"#,
        )
        .unwrap();

        let target = new_dir.join("config.json");
        assert!(migrate_config(&target).unwrap());
        let v: serde_json::Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
        assert_eq!(v["theme"], "light");
        assert_eq!(v["downloadDir"], "D:\\dl");
        assert!(v.get("startWithWindows").is_none());
        // original untouched, and a second run does not overwrite
        assert!(old_dir.join("config.json").is_file());
        assert!(!migrate_config(&target).unwrap());
        fs::remove_dir_all(&appdata).ok();
    }

    #[test]
    fn no_legacy_config_is_not_an_error() {
        let appdata = unique_tmp("none");
        let target = appdata.join("com.netguard.downloadmanager").join("config.json");
        assert!(!migrate_config(&target).unwrap());
        fs::remove_dir_all(&appdata).ok();
    }
}
