# NetGuard Download Manager

Windows download manager (Tauri 2 / Rust + React / TypeScript): multi-segment downloads, IDM-style
toolbar and download table, scheduler, browser extensions, system-tray mode.

> **Based on [Quantum Download Manager (QDM)](https://github.com/PBhadoo/QDM) 1.0.3** by Parveen Bhadoo
> (MIT, Copyright (c) 2026 Parveen Bhadoo). See [`LICENSE`](LICENSE) and [`NOTICE.md`](NOTICE.md).
> NetGuard changes are Copyright (c) 2026 NetGuard contributors (MIT).

**Read [`FINAL_REPORT.md`](FINAL_REPORT.md) first**: it states exactly what was tested, what was not, and what
still has to be verified on Windows and in real browsers.

## Get the Windows installer (GitHub Actions — recommended)

1. Create a GitHub repository and upload the *contents* of this folder (so `package.json` is at the repo root).
2. Open **Actions → "NetGuard - build and test (Windows)" → Run workflow** (branch `main`).
   It also runs automatically on pushes to `main`, pull requests and tags `v*`.
3. When the run is green, download the artifacts from the run page:
   | Artifact | Contents |
   |---|---|
   | `NetGuard-Installer` | `NetGuard-Setup.exe`, `NetGuard-Setup.exe.sha256` |
   | `NetGuard-Browser-Extensions` | `netguard-chromium-1.0.0.zip`, `netguard-firefox-1.0.0.zip` |
   | `NetGuard-Lockfile-and-Licenses` | regenerated `Cargo.lock` (commit it), `THIRD_PARTY_LICENSES.md` |
   | `NetGuard-Build-Logs` | one log file per step (uploaded even when a step fails) |
4. If a step fails, open `NetGuard-Build-Logs` and send the failing log. The Rust code in this package has
   **never been compiled** (see the report), so a first-run compile error is possible.

## Build on your own Windows PC

Prerequisites: Windows 10/11, Node 22, Rust stable (MSVC toolchain + "Desktop development with C++" build tools),
WebView2 runtime (preinstalled on Windows 11), Python 3.

```powershell
npm ci
node scripts/fetch-yt-dlp.js            # must come BEFORE any cargo command (bundle resource glob)
python -m pip install -r scripts/requirements-ci.txt   # PyYAML, needed by validate.py
python scripts/validate.py
npm run test:extension
npm run typecheck
npm run build
cd src-tauri
cargo test                               # engine, scheduler, migration, startup registry tests
cd ..
npm run tauri:build:win                  # -> src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\*-setup.exe
python scripts/package_extensions.py     # -> dist\extensions\*.zip
```

## Behaviour summary

* **Toolbar**: Add URL, Resume, Stop (keeps partial data), Remove, Delete Completed (list only, files are kept),
  Start Queue, Stop Queue, Scheduler, Logs, Search. **Table columns**: File name, Size, Status/progress, Speed,
  Time left, Category, Date added.
* **Queue** = every unfinished download. **Scheduler** starts it when a time window opens and stops it when it
  closes, while NetGuard is running (tray is fine).
* **Start with Windows** writes `HKCU\...\Run\NetGuard` = `"<exe>" --minimized`; the uninstaller removes it (not on
  upgrade). Launched with `--minimized` + "start minimized" setting → stays in the tray.
* **Single instance**: a second launch restores the running window.
* **Migration**: on first start NetGuard *copies* QDM settings and download state if found; QDM files are never
  modified or deleted (details in the report).
* **Update checking is disabled** until NetGuard has its own release feed (the upstream feed ships QDM installers).

## Browser extensions

`extension/chrome` is the single source for Chrome, Edge, Brave, Opera and Vivaldi (MV3, service worker);
`extension/firefox/manifest.json` produces the Firefox package (MV3 event page, Firefox 128+). Install:
Chromium → `chrome://extensions` → Developer mode → Load unpacked (unzip the package);
Firefox → `about:debugging` → Load Temporary Add-on → `manifest.json`. After installing, open the extension
popup, switch **Auto-intercept** on and tune *Interception settings*. Firefox asks you to grant site access.
**No browser has been tested** — see the report.

## License

MIT. The original QDM license is kept unmodified in [`LICENSE`](LICENSE) and installed as
`licenses/QDM-LICENSE.txt`. Third-party notices: [`NOTICE.md`](NOTICE.md).
