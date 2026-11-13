// Run: node extension/tests/background-flow.test.js   (no dependencies)
//
// Loads the REAL extension/chrome/background.js into a Node `vm` context with a mocked browser API
// and a mocked NetGuard HTTP endpoint, then fires the same `downloads.onCreated` event a browser
// raises when the user clicks a download link. It checks the extension-side hand-over logic in both
// "Chromium" and "Firefox" mode. It is NOT a test of a real browser (see README: manual checks).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'chrome');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ' + name); };

function stubDeep() {                       // any chrome.x.y.z(...) call resolves to undefined
  const f = function () { return Promise.resolve(undefined); };
  return new Proxy(f, { get: (_, k) => (k === 'then' ? undefined : (k === 'addListener' ? () => {} : stubDeep())), apply: () => Promise.resolve(undefined) });
}

/** Build an isolated extension instance. */
function boot({ firefox = false, intercept = true, ngUp = true, downloadStatus = 200, cookies = [], activeTab = { id: 7, url: 'https://tab.example/page' } } = {}) {
  const calls = { posts: [], cancelled: [], erased: [] };
  const listeners = { downloadsCreated: [] };
  const chrome = new Proxy({}, { get: (_, k) => chrome_[k] ?? stubDeep() });
  const chrome_ = {
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({ ngSettings: { interceptEnabled: intercept } }), set: async () => {} },
    },
    downloads: {
      onCreated: { addListener: (fn) => listeners.downloadsCreated.push(fn) },
      cancel: async (id) => { calls.cancelled.push(id); },
      erase: async (q) => { calls.erased.push(q.id); },
    },
    tabs: { query: async () => [activeTab], get: (id, cb) => cb(activeTab), onUpdated: { addListener() {} }, sendMessage() {} },
    cookies: { getAll: async () => cookies },
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, lastError: null },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setIcon() {} },
  };
  const fetchMock = async (url, opts = {}) => {
    const u = new URL(url);
    if (!ngUp) throw new TypeError('fetch failed (NetGuard not running)');
    if (u.pathname === '/sync') return { ok: true, status: 200, json: async () => ({ status: 'ok', token: 'tok-123', config: { enabled: true } }) };
    if (u.pathname === '/download') {
      calls.posts.push({ headers: opts.headers, body: JSON.parse(opts.body) });
      return { ok: downloadStatus === 200, status: downloadStatus };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  class FakeWS { constructor() { this.readyState = 0; } send() {} close() {} }
  const ctx = {
    chrome, fetch: fetchMock, WebSocket: FakeWS, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, AbortSignal, URL, URLSearchParams, Date, JSON, Math, Promise, Map, Set, Array, Object, String, Number, Boolean, RegExp, Error, TypeError, Uint8Array,
    navigator: { userAgent: 'test' },
  };
  if (firefox) ctx.browser = { runtime: { getBrowserInfo: async () => ({ name: 'Firefox' }) } };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  // Firefox loads ng-core.js through the manifest "scripts" list first; do the same in both modes.
  vm.runInContext(fs.readFileSync(path.join(SRC, 'ng-core.js'), 'utf8'), ctx, { filename: 'ng-core.js' });
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { calls, fire: async (item) => { for (const fn of listeners.downloadsCreated) await fn(item); }, ctx };
}

const ZIP = { id: 11, url: 'https://files.example.com/pkg/tool-1.0.zip', filename: 'C:\\Users\\x\\Downloads\\tool-1.0.zip', mime: 'application/zip', totalBytes: 5_000_000, referrer: 'https://files.example.com/downloads' };

(async () => {
  for (const mode of ['chromium', 'firefox']) {
    const firefox = mode === 'firefox';

    await t(`[${mode}] click on a file link: handed to NetGuard with token, cookies, referer, then browser copy cancelled`, async () => {
      const { calls, fire } = boot({ firefox, cookies: [{ name: 'sid', value: 'abc' }, { name: 'u', value: '1' }] });
      await fire(ZIP);
      assert.equal(calls.posts.length, 1);
      const { headers, body } = calls.posts[0];
      assert.equal(headers['X-NetGuard-Token'], 'tok-123');
      assert.equal(body.url, ZIP.url);
      assert.equal(body.file, 'tool-1.0.zip');
      assert.equal(body.cookie, 'sid=abc; u=1');
      assert.equal(body.tabUrl, 'https://files.example.com/downloads');   // real referrer wins over active tab
      assert.deepEqual(calls.cancelled, [11]);
      assert.deepEqual(calls.erased, [11]);
    });

    await t(`[${mode}] duplicate onCreated events for one click produce one hand-over`, async () => {
      const { calls, fire } = boot({ firefox });
      await fire(ZIP); await fire({ ...ZIP, id: 12 }); await fire({ ...ZIP, id: 13 });
      assert.equal(calls.posts.length, 1);
      assert.deepEqual(calls.cancelled, [11]);
    });

    await t(`[${mode}] NetGuard not running: nothing sent and the browser keeps its download`, async () => {
      const { calls, fire } = boot({ firefox, ngUp: false });
      await fire(ZIP);
      assert.equal(calls.posts.length, 0);
      assert.equal(calls.cancelled.length, 0);
    });

    await t(`[${mode}] NetGuard rejects the job: browser download is NOT cancelled (never lose a download)`, async () => {
      const { calls, fire } = boot({ firefox, downloadStatus: 401 });
      await fire(ZIP);
      assert.equal(calls.cancelled.length, 0);
    });

    await t(`[${mode}] interception switched off: browser handles everything`, async () => {
      const { calls, fire } = boot({ firefox, intercept: false });
      await fire(ZIP);
      assert.equal(calls.posts.length, 0);
      assert.equal(calls.cancelled.length, 0);
    });

    await t(`[${mode}] blob:/data: and web resources are never intercepted`, async () => {
      const { calls, fire } = boot({ firefox });
      await fire({ id: 1, url: 'blob:https://a.example/uuid', filename: 'x.zip' });
      await fire({ id: 2, url: 'data:text/plain,hi', filename: 'x.txt' });
      await fire({ id: 3, url: 'https://a.example/app.js', filename: 'app.js', totalBytes: 9e9 });
      assert.equal(calls.posts.length, 0);
    });

    await t(`[${mode}] missing content-length / no filename still hands over (size resolved by NetGuard)`, async () => {
      const { calls, fire } = boot({ firefox });
      await fire({ id: 5, url: 'https://dl.example.com/get?id=9', mime: 'application/octet-stream', totalBytes: 0, filename: '' });
      assert.equal(calls.posts.length, 1);
      assert.equal(calls.posts[0].body.file, '');
      assert.equal(calls.posts[0].body.contentLength, 0);
    });
  }
  console.log(`\n${n} extension flow tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
