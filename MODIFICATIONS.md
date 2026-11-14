# Modifications

NetGuard Download Manager **2.2.1.9** (made by Torik) is a modified version of
**Mister Download Manager 0.5.2**, by Ahmed Nefzaoui
(<https://github.com/anefzaoui/misterdownloadmanager>), which is free software under the
**GNU General Public License, version 3 or later** (the [LICENSE](LICENSE), unchanged: a
byte-for-byte copy of the original's). NetGuard is released under the same licence, as the
GPL requires of a modified version, and its complete source is this repository.

The original copyright notices are kept as they were (`Copyright (c) 2026 Ahmed Nefzaoui`, in
the README, the installer and the program's file properties, now followed by NetGuard's
modification line), as is every third-party notice and licence ([ATTRIBUTION.md](ATTRIBUTION.md)).
NetGuard's own changes are not the original author's work and he has not endorsed them. The
[NOTICE](NOTICE) file says the same in short.

## Versions

| | Version |
| --- | --- |
| Original source this was made from | Mister Download Manager **0.5.2** (2026-11-09) |
| NetGuard Download Manager | **2.2.1.9** |

NetGuard's version is not a continuation of the original's numbering. It is kept in one place,
`crates/ipc/src/lib.rs` (`product_version!`, `PRODUCT_VERSION`), and shown in the window title,
**Help → About**, the command line's `--version`, the browser host and the MCP server, and
used by the installer, the release workflow and the extension packager. Cargo accepts only
three-part versions, so `Cargo.toml` and `Cargo.lock` say `2.2.1`; the fourth number lives only
in `PRODUCT_VERSION`. A release tag is `v2.2.1.9`.

## History

### NetGuard Download Manager 2.2.1.9, from Mister Download Manager 0.5.2

**Branding**

- The product is named *NetGuard Download Manager* (short name *NetGuard*) wherever the original
  said *Mister Download Manager* or *MDM* to the user: the window titles, About, menus, dialogs,
  messages, the Windows file properties, the installer and shortcuts, the tray, the browser
  extension's name and pop-up, the remote-control page, the user guide (`docs/`), the README and
  the workflows. This includes the 90 language catalogs in `i18n/` and the extension's locale
  files, changed together with the English texts they translate (the English text is the key).
- A new logo and icons (a shield with a download arrow), drawn by `tools/icon/build_icon.py`,
  replace the original's: the app icon and `.ico`, the tray icon, the extension's icons,
  `docs/images/logo.png`, `docs/images/social-preview.png`. `art/Mister Download Manager.png` is
  replaced by `art/NetGuard Download Manager.png`.
- **Help → About** shows *NetGuard Download Manager*, *Version 2.2.1.9*, *Made by Torik*, and
  says the program is based on Mister Download Manager 0.5.2 by Ahmed Nefzaoui, GPL-3.0.
- The **Help → Support** item and About's Sponsors link, which go to the original author's
  GitHub Sponsors page, are labelled *Support the original project*.

**Colour theme**

- A new built-in theme, **NetGuard** (`crates/app/assets/themes/netguard.toml`, registered in
  `crates/app/src/palette.rs`, offered in **View → Theme**): dark navy with emerald-green
  accents (background `#0B1220`, secondary background `#111C2E`, surface `#17243A`, accent
  `#10B981`, hover `#059669`, text `#F8FAFC`, secondary text `#94A3B8`, borders `#26354B`),
  dark in both modes. It is the default for a profile that has not chosen a theme; a saved
  choice is kept, and all nine themes, including Classic (the original look), are available.
- The remote-control page (`crates/remote/web/`), the extension's pop-up and the in-page
  video button use the same palette. Layout, sizes, spacing, type and behaviour are the
  original's.

**Release, update and reporting targets**

- The extension's in-page button carries the new icon (`extension/video.js`'s embedded logo, which
  `tools/extension/test.mjs` requires to equal `extension/icons/icon-48.png`).

- Builds made by `.github/workflows/release.yml` are compiled with `NETGUARD_REPO`,
  `NETGUARD_REPO_URL` and `NETGUARD_UPDATE_FEED` set from the repository running the workflow, so
  **Check for updates**, **Report a problem**, crash reports and the licence links use *that*
  repository, not the original's. A build without them (a plain `cargo build`) still points at
  the original project. `NETGUARD_SITE_URL` can likewise name a site; without it the Help pages
  are the original project's website.
- *Update now* installs only a release whose `SHA256SUMS.txt` is signed with the original
  project's release key. NetGuard releases are not (that key is the original author's), so
  NetGuard never installs an update by itself: the update dialog offers the release page.
  To change that, replace `crates/tools/keys/mdm-release.asc` with your own public key, sign
  `SHA256SUMS.txt` with the matching key in the release workflow, and update the key tests.
- `.github/workflows/pages.yml` (the original project's website) builds only where the
  repository variable `NETGUARD_PUBLISH_SITE` is `true`.
- The installer, the packagers and the extension packager read the product version from
  `crates/ipc/src/lib.rs`, not `Cargo.toml`; `NOTICE` and `MODIFICATIONS.md` are packed with
  `LICENSE` and `ATTRIBUTION.md` in every installer, archive and package.

**Documentation**

- `README.md` starts with a notice that NetGuard is a fork; the original project's badges, star
  history and store links are removed or marked as the original's. The original contributors'
  thanks stays, marked as theirs. `docs/themes.md` and `docs/getting-started.md` describe the
  new theme. This file, `NOTICE` and `ATTRIBUTION.md`'s opening are new.
- Links in `docs/` and `SECURITY.md` to the original's releases, issues, source and security
  advisories now point at this repository (relative links); the original's website pages stay
  where they are an explicit reference (named as the original project's), and the extension store
  listings are the original's. The README's account of how the program was built (the
  "clean-room" section) is marked as the original author's statement, not NetGuard's.
- Provenance records are untouched: the `SOURCES.txt` of the Luna, Aero and Aqua icon sets still
  say they were drawn for Mister Download Manager.
- The original's `CHANGELOG.md`, `ROADMAP.md`, `LICENSE`, `website/` and `i18n/site/` are
  unchanged, and `CHANGELOG.md` has a new section for 2.2.1.9 above the original's history.
- The screenshots in `docs/images/` are the original project's and show its name and Classic
  look; they were not retaken. The charts `races-*.svg` and `bench-time-*.svg` carry the new name
  (the figures are the original 0.5.2's measurements).

## What did not change

The program's code, features, architecture, settings and behaviour: the download engine,
connections, pause and resume, queues, the scheduler, the speed limiter, browser integration,
video, torrents and magnets, batch and gallery downloads, archive extraction, remote control, the
command line, the MCP server, categories, history, notifications, localization and keyboard
shortcuts.

Internal names are the original's, on purpose, so existing data, upgrades and tools keep
working: the crates (`mdm-*`), the programs' file names (`misterdownloadmanager*.exe`), the
installer's and the release files' names (`MisterDownloadManager-<version>-…`, which the update
check looks for), environment variables (`MDM_*`), the data folder, the registry keys, the
browser host's and extension's identifiers, window classes and keychain names.
Rust source comments still say *MDM*.

## How to check

Compare this tree with the original source archive (`misterdownloadmanager-0.5.2.zip`): every
difference is one of the above. `python tools/i18n/extract.py --check` passes on both.
