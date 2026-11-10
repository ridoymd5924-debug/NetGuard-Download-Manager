# NetGuard Download Manager — final implementation and test report

Legend: **PASSED** = actually executed here and succeeded · **NOT RUN** = unavailable in the authoring environment ·
**REQUIRES WINDOWS** = needs your PC / Windows CI · **REQUIRES BROWSER** = needs a real browser.

**Bottom line.** All Rust code in this package (previous round *and* this one) has **never been compiled or run**:
the authoring sandbox has no Rust toolchain, no network, no Windows and no browser. The project is **not** shown to be
production-ready. The first Windows CI run is the real test; a compile error in Rust is possible and would be fixed from
the uploaded log. The installer has not been built or tested.

## 1. Features completed (CODE ONLY unless stated)

* **Toolbar (IDM-style)**: Add URL, Resume, Stop, Remove, **Delete Completed**, **Start Queue**, **Stop Queue**,
  **Scheduler**, Logs, Search; icon+label buttons, labels hide below 1024 px, tooltips, disabled states, error banner.
  Per-row/context-menu "Pause" is now "Stop". *(The old "Pause All / Resume All / Delete All" buttons were folded into
  Stop Queue / Start Queue / select-all + Remove.)*
* **Download table** with columns File name, Size, Status+progress, Speed, Time left, **Category**, **Date added**;
  select-all checkbox; Category/Date hide on narrow windows.
* **Scheduler** (new): dialog + backend. The queue manager now detects the moment a window opens/closes and starts/stops
  downloads (it previously only emitted an event nothing listened to). Queue = every unfinished download.
* **Tray**: dedicated `tray.png` is used (no longer the window icon); the duplicate config-defined tray icon was removed;
  only a completed *left* click restores the window, right click opens the menu; menu: Open / New Download / Pause All /
  Resume All / Exit. Exit and every exit path pause downloads and persist state first (4 s cap).
* **Theme**: persisted in config, applied at startup *before first paint* (localStorage mirror + inline script) and in
  every window through one helper.
* **Branding**: window/page title was still "Quantum Download Manager" → fixed; remote Google Fonts calls removed
  (privacy + offline); invalid Tailwind class names (`ng-text-muted`) fixed; installer/NOTICE/About keep QDM attribution.
* **QDM → NetGuard migration** (`migration.rs`): copy-only, idempotent, never overwrites NetGuard data, writes
  `downloads.json` last, validates JSON, drops QDM's `startWithWindows`, skips partial folders > 2 GiB (those restart from 0).
  Locations: settings `config.json` in a sibling folder whose name contains `qdm`/`quantum` (the old bundle identifier is
  not hard-coded because it is not recorded anywhere in this package), data `<download dir>/.qdm_data`. **The `.qdm_data`
  name is inferred from the project's `.gitignore`, not verified against a real QDM install.**
* **Extensions**: single interception path (no duplicates), hand-over-then-cancel, reconnect with backoff + keep-alive,
  works after service-worker restart, alarm period fixed (`0.1` min is clamped by browsers → `0.5` Chromium / `1` Firefox),
  **interception settings UI** (min size, file types, excluded sites), Firefox-safe `webRequest` (see bugs), notification
  icon path fixed, unused `scripting` permission removed, Firefox manifest loads `ng-core.js`, Firefox ≥ 128.
* **Licensing**: LICENSE byte-identical to QDM's; NOTICE.md rewritten with real npm licence summary; GPL-FFmpeg note;
  `scripts/license_report.py` + CI step.

## 2. Bugs fixed this round (found by reading the code; none reproduced at runtime)

1. **Security**: `/sync` returned the session token with `Access-Control-Allow-Origin: *` — any web page could read it and drive
   the local server. CORS now allows only extension origins; `/sync`, `/show` and `/ws` reject web-page `Origin`s (WebSockets
   ignore CORS, so `/ws` leaked download events to any page).
2. **Firefox**: `webRequest` was registered with `extraHeaders`, which Firefox rejects with a TypeError — the whole background
   script would have failed to load.
3. **Duplicate downloads**: `webRequest` *and* `downloads.onCreated` both sent `/download`, and `webRequest` never cancelled the
   browser's copy. Now one path; browser copy cancelled only after NetGuard accepted the job.
4. After a service-worker restart `isNgRunning` was false, so interception silently did nothing → `ensureConnected()`.
5. **Concurrency limit** could be exceeded (check and increment under different locks) with Resume All / Start Queue.
6. **Queued items got stuck** after Pause All and after an app restart; pausing a download never woke the queue.
7. Pause recorded a bogus `"cancelled"` error and marked segments Failed; the splitter could add segments after a pause.
8. UI never learned about pause/start/cancel/remove of items without a progress event (stale statuses).
9. Config-defined tray icon + code tray icon (two icons); any click (even right-click) restored the window.
10. Scheduler was a no-op. 11. `update_download_install` kept ~100 lines of dead code that would download QDM installers.
12. `AppConfig` TypeScript type lacked `ytdlpPath`/`ytdlpBrowser` → `npm run typecheck` would have failed in CI.
13. `tailwind.config.js`/`postcss.config.js` used ESM syntax in a CommonJS package → renamed `.cjs`.
14. `cargo test` would fail before the yt-dlp resource existed (tauri-build validates the glob) → workflow fetches it first.
15. yt-dlp was fetched without integrity checking → SHA-256 verified against the release's `SHA2-256SUMS`.
16. Close handler `block_on` on the UI thread → `try_lock`.

## 3. Tests actually executed

| Check | Result |
|---|---|
| `python scripts/validate.py` (62 checks: JSON/TOML/YAML parse, package-lock ↔ package.json, versions agree, Cargo deps/features, tauri.conf + installer files + icons exist, both manifests, every referenced extension file, Firefox/alarm/dedupe invariants, licence + attribution, branding, no TODO/FIXME) | **PASSED** |
| Extension logic unit tests (`node extension/tests/ng-core.test.js`, 12 tests) | **PASSED** |
| `node --check` on all extension JS + `scripts/fetch-yt-dlp.js`; yt-dlp checksum-parser self-test | **PASSED** |
| esbuild parse of every `src/**/*.ts(x)` (0 errors) and full bundle of `src/main.tsx` (all relative imports resolve) | **PASSED** |
| `tsc --strict` over `src/` using **hand-written stub typings** for react/zustand/lucide/tauri (real `@types/*` not installable offline): only stub artefacts remain, 0 genuine errors after fixing #12 | **PASSED (partial — stubs)** |
| `package-lock.json` consistent with `package.json`; 195 npm licences listed (no GPL/AGPL) | **PASSED** |
| Extension packaging (`package_extensions.py`) builds both zips with LICENSE + NOTICE | **PASSED** |
| Rust delimiter balance before/after my edits (weak, not a compile) | unchanged |
| Real `tsc` with real types, `vite build` | **NOT RUN** (no npm network) |
| `cargo fmt/check/test/clippy`, Cargo.lock regeneration, crate licence report | **NOT RUN** (no Rust) |
| Tauri config schema validation (only JSON parse + referenced-file existence done) | **NOT RUN** |
| 18 Rust unit tests written (17 + 1 Windows-only) (engine range/Content-Range/retry/splitter/SHA-256 = 5, browser origin rules = 2, scheduler windows/transitions = 3, migration = 5, startup = 2 + 1 Windows registry round-trip) | **NOT RUN → run in CI** |
| NSIS build, installer install/uninstall/startup-cleanup (`scripts/ci/test-installer.ps1`), tray, `--minimized` launch, reboot launch, single instance, upgrade | **REQUIRES WINDOWS** |
| Engine against real servers (no-Range server, changing ETag, stalls, pause at 20/50/80 %, restart recovery, long downloads) — **no integration tests exist**, only unit tests of the helpers | **NOT RUN / NOT WRITTEN** |
| Chrome, Edge, Brave, Opera, Vivaldi, Firefox: load, connect, intercept, popup settings | **REQUIRES BROWSER** (compatibility is *not* verified) |
| Visual check of toolbar/table/dialogs/themes/responsive layout | **REQUIRES WINDOWS** (never rendered) |

## 4. Known limitations

* Rust never compiled (see top). `Cargo.lock` is stale (lacks `tauri-plugin-single-instance`; `winreg`
  is locked at 0.55 transitively while Cargo.toml asks 0.52); CI regenerates it and uploads the result — commit that file.
* Scheduler only works while NetGuard is running; no "shut down / sleep when finished" action. Queue is global (all unfinished downloads).
* YouTube/yt-dlp quality prompts still bring the main window to the front (the picker lives there); ordinary downloads use the separate dialog window.
* `csp` is `null` in `tauri.conf.json` (a CSP could not be tested without a WebView; recommended follow-up).
* Update checking disabled. No code signing → Windows SmartScreen will warn. No store submission / Firefox signing.
* Migration relies on inferred QDM names (see §1) and does not move large partials; failures only log a warning.
* Firefox MV3: users must grant site access; Chromium keep-alive relies on WebSocket traffic (Chrome ≥ 116).
* Dependency licences for Rust crates not machine-checked yet; FFmpeg is downloaded as a GPL build at runtime.
* Icons/branding assets were generated earlier; not re-inspected visually this round.

## 5. Exact Windows build procedure
See README → "Build on your own Windows PC" (order matters: `fetch-yt-dlp.js` before any `cargo` command).

## 6. GitHub Actions trigger
Upload the folder contents to a repo (root contains `package.json`) → **Actions → "NetGuard - build and test (Windows)" →
Run workflow**. Also automatic on push to `main`, PRs, tags `v*`. Typical duration 20–40 min.

## 7. Expected artifacts
`NetGuard-Installer` → `NetGuard-Setup.exe`, `NetGuard-Setup.exe.sha256` · `NetGuard-Browser-Extensions` →
`netguard-chromium-1.0.0.zip`, `netguard-firefox-1.0.0.zip` · `NetGuard-Lockfile-and-Licenses` → `Cargo.lock`,
`THIRD_PARTY_LICENSES.md` · `NetGuard-Build-Logs` → `logs/*.log`.
