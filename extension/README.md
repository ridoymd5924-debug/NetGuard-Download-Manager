# NetGuard browser extensions

* `chrome/` — Manifest V3 source shared by Chrome, Edge, Brave, Opera, Vivaldi (service worker `background.js`).
* `firefox/manifest.json` — Firefox MV3 manifest (event page; loads `ng-core.js` then `background.js`; Firefox 128+).
* `chrome/ng-core.js` — pure logic (interception rules, settings sanitising, de-duplication, filename parsing),
  unit-tested by `tests/ng-core.test.js` (`node extension/tests/ng-core.test.js`).
* `packages/` — pre-built packages produced by `python scripts/package_extensions.py`.

Design notes: browser downloads are taken over in **one** place (`downloads.onCreated`): the job is sent to NetGuard
first and the browser's copy is cancelled only after NetGuard accepted it; if NetGuard is not running the browser
download proceeds normally. `webRequest` only reports media streams. The extension talks to `127.0.0.1:8597` with a
per-session token (`X-NetGuard-Token`); the app refuses web-page origins on `/sync`, `/show` and `/ws`.
