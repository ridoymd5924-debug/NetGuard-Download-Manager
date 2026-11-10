//! Windows login-startup registration (per-user, no administrator rights).
//!
//! Writes `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\NetGuard` with the quoted path of the
//! running executable plus `--minimized`. The value name is fixed so that the NSIS uninstaller can
//! delete exactly this entry (see `src-tauri/installer-hooks.nsh`).

pub const RUN_VALUE_NAME: &str = "NetGuard";
pub const MINIMIZED_ARG: &str = "--minimized";

/// The command line stored in the registry.
fn command_line(exe: &std::path::Path) -> String {
    format!("\"{}\" {}", exe.display(), MINIMIZED_ARG)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED_KEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

    fn exe() -> Result<std::path::PathBuf, String> {
        std::env::current_exe().map_err(|e| e.to_string())
    }

    /// True only if the Run value exists AND points at the currently running executable.
    pub fn is_registered() -> bool {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(key) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ) else { return false };
        let Ok(cur): Result<String, _> = key.get_value(RUN_VALUE_NAME) else { return false };
        match exe() {
            Ok(p) => cur.eq_ignore_ascii_case(&command_line(&p)),
            Err(_) => false,
        }
    }

    pub fn enable() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        // set_value on an existing name overwrites it: never a duplicate entry, and a stale
        // path left by a previous version/install location is repaired.
        key.set_value(RUN_VALUE_NAME, &command_line(&exe()?))
            .map_err(|e| e.to_string())?;
        // If the user previously disabled us in Task Manager > Startup, Windows keeps a
        // "disabled" flag here; clear it so that turning the option on actually works.
        if let Ok(ap) = hkcu.open_subkey_with_flags(APPROVED_KEY, KEY_WRITE) {
            let _ = ap.delete_value(RUN_VALUE_NAME);
        }
        Ok(())
    }

    pub fn disable() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let Ok(key) = hkcu.open_subkey_with_flags(RUN_KEY, KEY_WRITE) else { return Ok(()) };
        match key.delete_value(RUN_VALUE_NAME) {
            Ok(()) => Ok(()),
            // Already absent is success.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn is_registered() -> bool { false }
    pub fn enable() -> Result<(), String> {
        Err("Start with Windows is only available on Windows".into())
    }
    pub fn disable() -> Result<(), String> { Ok(()) }
}

/// Make the OS state match `want`, then return the state actually observed afterwards.
pub fn apply(want: bool) -> Result<bool, String> {
    if want { imp::enable()? } else { imp::disable()? }
    let actual = imp::is_registered();
    if actual != want {
        return Err(format!(
            "Startup registration did not take effect (wanted {want}, found {actual})"
        ));
    }
    Ok(actual)
}

/// Re-sync at app launch. Repairs a stale path after an upgrade; never creates an entry when off.
pub fn resync(want: bool) -> Result<bool, String> {
    if want { imp::enable()?; } else if imp::is_registered() { imp::disable()?; }
    Ok(imp::is_registered())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_line_is_quoted_and_minimized() {
        let c = command_line(std::path::Path::new(r"C:\Program Files\NetGuard\netguard.exe"));
        assert_eq!(c, "\"C:\\Program Files\\NetGuard\\netguard.exe\" --minimized");
    }
    #[test]
    fn value_name_is_stable() { assert_eq!(RUN_VALUE_NAME, "NetGuard"); }

    /// Runs on the Windows CI runner: really writes/removes HKCU\...\Run\NetGuard.
    #[cfg(windows)]
    #[test]
    fn windows_registry_roundtrip() {
        // Start clean, enable, verify, enable again (no duplicate/err), disable, verify gone.
        let _ = apply(false);
        assert!(!imp::is_registered());
        assert_eq!(apply(true), Ok(true));
        assert!(imp::is_registered());
        assert_eq!(apply(true), Ok(true), "enabling twice must be idempotent");
        assert_eq!(resync(true), Ok(true));
        assert_eq!(apply(false), Ok(false));
        assert!(!imp::is_registered());
        assert_eq!(apply(false), Ok(false), "disabling when absent must succeed");
        assert_eq!(resync(false), Ok(false), "resync(false) must never create an entry");
        assert!(!imp::is_registered());
    }
}

