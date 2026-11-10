# NetGuard Download Manager — Notices

## Origin and attribution

NetGuard Download Manager is a derivative work based on **Quantum Download Manager (QDM) 1.0.3**,
created by **Parveen Bhadoo** and released under the MIT License
(upstream: https://github.com/PBhadoo/QDM).

- Original QDM code: Copyright (c) 2026 Parveen Bhadoo — MIT License. The complete, unmodified
  license text is in [`LICENSE`](LICENSE) and is installed with the application
  (`licenses/QDM-LICENSE.txt`).
- NetGuard additions and modifications (branding, UI redesign, Windows startup integration,
  installer, and related changes): Copyright (c) 2026 NetGuard contributors, also released under the
  MIT License. NetGuard contributors do not claim ownership of the original QDM code.

QDM in turn credits Xtreme Download Manager (XDM, by subhra74) as architectural inspiration.

## Third-party components

All dependencies resolved at the time of writing use permissive licenses. Authoritative, regenerated lists:

* **npm (195 packages in `package-lock.json`)** — checked with `python scripts/license_report.py`:
  MIT (166), Apache-2.0 OR MIT (13), ISC (10), Apache-2.0 (4), BSD-3-Clause (1), CC-BY-4.0 (1 — `caniuse-lite`,
  a build-time data package that is not shipped in the application).
  Shipped runtime libraries: React, React DOM, zustand, lucide-react (ISC), `@tauri-apps/api` (Apache-2.0 / MIT).
  Tailwind CSS, PostCSS, Autoprefixer, Vite and TypeScript are build-time tools.
* **Rust crates** — Tauri 2 and plugins (Apache-2.0 / MIT), tokio, reqwest, axum, tower-http, serde, chrono, uuid,
  futures, url, dirs, arboard, m3u8-rs, roxmltree, which, zip, aes, cbc, hex, sha2, base64, winreg (all MIT and/or
  Apache-2.0 as published on crates.io). **This list was NOT machine-verified in the authoring environment (no Rust
  toolchain).** The CI workflow runs `scripts/license_report.py`, which reads the license of every crate from
  `cargo metadata`, fails on GPL/AGPL/SSPL/BUSL, and uploads `THIRD_PARTY_LICENSES.md`. Review that file before
  publishing a release and ship it with the installer if you distribute binaries widely.
* **Fonts** — NetGuard uses system fonts (Segoe UI / Cascadia). No remote font is loaded.

Optional runtime tools are **separate programs** with their own licenses; NetGuard does not link against them:

* **yt-dlp** — Unlicense. Bundled into the installer by `scripts/fetch-yt-dlp.js` after SHA-256 verification.
* **FFmpeg** — downloaded on the user's machine on first use from the BtbN builds. That build is the **GPL** variant
  (`...win64-gpl.zip`), run only as a separate process and not redistributed by NetGuard. If you ever bundle FFmpeg
  into the installer, you take on the GPL's obligations (source offer, license text) or must switch to an LGPL build.

NetGuard does not bypass DRM or access restrictions.
