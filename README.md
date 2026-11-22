<p align="center">
  <img src="docs/images/logo.png" alt="NetGuard Download Manager" width="128" height="128">
</p>

<h1 align="center">NetGuard Download Manager</h1>

<p align="center">
  A fast, free and open-source download manager for Windows, in a dark navy and emerald look.
</p>

<p align="center">
  <a href="https://github.com/ridoymd5924-debug/NetGuard-Download-Manager/releases"><img src="https://img.shields.io/github/v/release/ridoymd5924-debug/NetGuard-Download-Manager?label=release" alt="Latest release"></a>
  <a href="https://github.com/ridoymd5924-debug/NetGuard-Download-Manager/actions/workflows/ci.yml"><img src="https://github.com/ridoymd5924-debug/NetGuard-Download-Manager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ridoymd5924-debug/NetGuard-Download-Manager" alt="GPL-3.0 license"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-10B981" alt="Windows 10 and 11">
</p>

---

**NetGuard Download Manager** (short name: **NetGuard**) speeds up downloads by fetching a file in
several parts at once, resumes them after a crash or a dropped connection, catches downloads from
your browser, and downloads videos, galleries and torrents. It is laid out the way people who
know classic download managers expect, and it runs on Windows 10 and 11.

NetGuard is a fork of [Mister Download Manager](https://github.com/anefzaoui/misterdownloadmanager)
0.5.2 by Ahmed Nefzaoui. It changes the name, the logo, the colour theme and the distribution
(Windows only); the download engine and every feature are the original's. See
[Credits and licence](#credits-and-licence).

## Download

Go to the [**Releases** page](https://github.com/ridoymd5924-debug/NetGuard-Download-Manager/releases)
and pick the files of the newest release:

| File | What it is |
|---|---|
| `NetGuard-Download-Manager-<version>-setup.exe` | **The installer** (recommended). Installs for you only, or for everyone; sets up browser integration, `.torrent` and magnet links, and start with Windows if you ask. |
| `NetGuard-Download-Manager-<version>-portable.zip` | Unzip anywhere (a USB stick, say): the list and settings stay in its `data` folder, nothing is written to the registry. |
| `NetGuard-Download-Manager-<version>-x64.zip` | The same programs without an installer; settings in `%APPDATA%`. |
| `NetGuard-Download-Manager-<version>-extension-chromium.zip` | The browser extension for Chrome, Edge, Brave, Opera and Vivaldi (unzip, then **Load unpacked**). |
| `NetGuard-Download-Manager-<version>-extension-firefox.xpi` | The browser extension for Firefox (temporary add-on, `about:debugging`). |
| `SHA256SUMS.txt` | The checksums of every file above. |

**Install:** run the setup, follow the wizard. If Windows SmartScreen warns about an unsigned
program, choose **More info → Run anyway** (the releases are not code-signed yet).
**Requires:** Windows 10 or 11, 64-bit.

> This release has **no automatic updates**: NetGuard does not check for a newer version by
> itself. Download the new setup from the Releases page and run it over the old one.

## What it does

- **Speeds up every download** by fetching parts of the file at the same time, and keeps
  re-balancing until the last byte.
- **Resumes** after a crash, a restart or a dropped connection, without starting over.
- **Catches downloads from Firefox, Chrome, Edge, Brave, Opera and Vivaldi** through the browser
  extension, and gives them back to the browser when NetGuard isn't running.
- **Downloads videos** from web pages (a button appears over the video; playlists, subtitles,
  the sound alone), **image galleries** with gallery-dl, and **torrents and magnet links**
  (sequential order, RSS feeds, sharing limits).
- **Many links at once**: the Link grabber sorts them into packages and extracts archives
  (zip, 7z, rar). Debrid accounts (Real-Debrid, AllDebrid, Premiumize; experimental) download
  file-host links through your own account.
- **Downloads overnight** with queues and a scheduler that can wake the computer, then shuts it
  down if you like.
- **Through your VPN only**, if you want: hold every download to one network adapter, with a kill
  switch, and choose an encrypted DNS. Each download shows its server's country.
- **From your phone, or on a server**: control NetGuard from a phone on your home network
  ([how](docs/remote-control.md)).
- **Works from scripts too**: IDM-style command-line switches, a command-line tool, and a local
  API for other programs ([how](docs/command-line.md)).
- **Works with your AI assistant**: an MCP server lets Claude, Cursor or VS Code list, add, pause
  and remove your downloads ([set it up](docs/ai-assistants.md)).
- **Leaves you some speed**: limit one download or all of them, only while you're at the computer.
- **Dark Navy and Emerald by default**, with the original **Classic** look, **Native**, **High
  contrast** and the style themes (Metro, Adwaita, Breeze, Luna, Aero, Aqua) one click away in
  **View → Theme**, or your own theme in a text file ([how](docs/themes.md)). Everything larger,
  up to 200 %, with **View → Interface size**. 86 languages, and a portable version.
- **Works from the keyboard and with screen readers** (Narrator, NVDA)
  ([the keys](docs/keyboard-shortcuts.md)).
- **No ads, no trial, no account**. Free and open source.

Step by step: [your first download](docs/guide-first-download.md) ·
[catch every browser download](docs/guide-catch-browser-downloads.md) ·
[download overnight](docs/guide-download-overnight.md) ·
[download a video](docs/guide-video-from-page.md) · [all help pages](docs/README.md)

## Colours

The interface uses the NetGuard palette:

| Role | Colour |
|---|---|
| Background | `#0B1220` |
| Secondary background | `#111C2E` |
| Panel background | `#17243A` |
| Primary accent | `#10B981` |
| Secondary accent | `#059669` |
| Main text | `#F8FAFC` |
| Secondary text | `#94A3B8` |
| Borders | `#26354B` |

It is the built-in theme `crates/app/assets/themes/netguard.toml`; the layout and controls are
the classic ones.

## Build from source

Requires Windows, [Rust](https://rustup.rs) stable 1.95 or later (the MSVC toolchain), and
`git` (some dependencies come from Git repositories).

```
cargo build --release
cargo test --workspace
```

This makes `misterdownloadmanager.exe` (the app), `misterdownloadmanager-cli.exe` (the command
line), `misterdownloadmanager-mcp.exe` (the MCP server) and `misterdownloadmanager-nmhost.exe`
(the browser host) in `target\release\`. The file names are kept from the original program so
that browser integration, settings and scripts stay compatible; the program itself, its windows,
the installer and its shortcuts all say NetGuard Download Manager.

**The installer and zips:** install [Inno Setup 6](https://jrsoftware.org/isinfo.php), then run
`tools\installer\build.ps1`. The files appear in `target\dist\`.

**On GitHub:** a pushed tag such as `v0.5.2` (matching `version` in `Cargo.toml`) runs the
[Release workflow](.github/workflows/release.yml), which builds the Windows installer, the zips
and the extensions and publishes them as a GitHub release. You can also run it by hand from the
**Actions** tab to get the files as workflow artifacts without publishing.
The [CI workflow](.github/workflows/ci.yml) checks formatting, lints and tests on Windows for
every push to `main` and every pull request.

Browser integration from a build: register the native messaging host with
`target\release\misterdownloadmanager-nmhost.exe --register` (undo with `--unregister`), then in
`chrome://extensions` or `edge://extensions` turn on Developer mode, **Load unpacked** and pick
the `extension/` folder.

More: [CONTRIBUTING.md](CONTRIBUTING.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[ROADMAP.md](ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md)

## Help and bug reports

The user guide is in [`docs/`](docs/README.md). Bug reports and ideas are welcome in
[Issues](https://github.com/ridoymd5924-debug/NetGuard-Download-Manager/issues/new/choose):
**Help → Report a problem** in the app fills in your version and system. Security problems:
see [SECURITY.md](SECURITY.md).
