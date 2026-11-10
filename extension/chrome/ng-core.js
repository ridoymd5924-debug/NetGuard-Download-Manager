/**
 * NetGuard extension — pure, browser-independent logic (no chrome.* calls) so it can be unit
 * tested with Node (extension/tests/ng-core.test.js). Loaded by the Chromium service worker with
 * importScripts() and by the Firefox event page through the manifest "scripts" list.
 */
(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    interceptEnabled: false,          // master switch (off until the user opts in)
    minSizeMB: 0,                     // ignore downloads smaller than this when size is known
    extensions: [                     // always intercepted
      'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab',
      'exe', 'msi', 'dmg', 'deb', 'rpm', 'appimage', 'apk',
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'iso', 'img', 'bin', 'torrent', 'epub', 'mobi', 'azw3',
      'mp4', 'mkv', 'webm', 'avi', 'mov', 'flv', 'm4v', 'wmv',
      'mp3', 'flac', 'wav', 'aac', 'ogg', 'wma', 'm4a', 'opus',
    ],
    excludedHosts: [],                // never intercept these hosts (and their subdomains)
  });

  const SKIP_EXTS = new Set([
    'html', 'htm', 'php', 'asp', 'aspx', 'jsp', 'js', 'mjs', 'cjs', 'css', 'scss', 'less',
    'json', 'xml', 'svg', 'woff', 'woff2', 'ttf', 'eot', 'ico', 'cur', 'map', 'webmanifest', 'ts',
    'enc', 'crypt', 'crypt12', 'crypt14', 'crypt15', 'aes', 'drm', 'wvd',
  ]);

  const SKIP_HOSTS = new Set([
    'mmg.whatsapp.net', 'media.whatsapp.net', 'static.whatsapp.net', 'web.whatsapp.com',
    'cdn4.telegram-cdn.org', 'cdn1.telegram-cdn.org',
    'accounts.google.com', 'oauth2.googleapis.com', 'login.microsoftonline.com',
  ]);

  const DOWNLOAD_MIME_PREFIXES = [
    'application/octet-stream', 'application/zip', 'application/x-rar', 'application/x-rar-compressed',
    'application/x-7z-compressed', 'application/gzip', 'application/x-tar', 'application/pdf',
    'application/x-msdownload', 'application/x-msi', 'application/x-ms-installer',
    'application/x-apple-diskimage', 'application/vnd.android.package-archive', 'application/x-bittorrent',
  ];

  function getExt(url) {
    try {
      const path = new URL(url).pathname;
      const dot = path.lastIndexOf('.');
      if (dot > 0) {
        const ext = path.substring(dot + 1).toLowerCase();
        if (ext.length <= 10 && /^[a-z0-9]+$/.test(ext)) return ext;
      }
    } catch (e) { /* not a URL */ }
    return '';
  }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  function hostMatches(host, list) {
    return list.some((h) => host === h || host.endsWith('.' + h));
  }

  /** Accepts whatever is in storage (or user input) and returns a complete, safe settings object. */
  function normalizeSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const cleanList = (v) => (Array.isArray(v) ? v : [])
      .map((x) => String(x).trim().toLowerCase().replace(/^\./, '').replace(/^\*\./, ''))
      .filter((x) => x && /^[a-z0-9.-]+$/.test(x));
    const min = Number(r.minSizeMB);
    return {
      interceptEnabled: r.interceptEnabled === true,
      minSizeMB: Number.isFinite(min) && min >= 0 ? Math.min(min, 100000) : 0,
      extensions: Array.isArray(r.extensions) ? cleanList(r.extensions) : DEFAULT_SETTINGS.extensions.slice(),
      excludedHosts: cleanList(r.excludedHosts),
    };
  }

  /** Parse "a, b ; c\nd" (textarea input) into a list. */
  function parseListInput(text) {
    return String(text || '').split(/[\s,;]+/).filter(Boolean);
  }

  /**
   * Decide whether a browser download should be taken over by NetGuard.
   * item: { url, mime, totalBytes, filename }
   */
  function shouldIntercept(item, settingsIn) {
    const s = normalizeSettings(settingsIn);
    if (!s.interceptEnabled) return false;
    const url = item && item.url;
    if (!url || !/^https?:/i.test(url)) return false;       // blob:, data:, file:, ftp: stay in the browser
    const host = hostOf(url);
    if (SKIP_HOSTS.has(host) || hostMatches(host, s.excludedHosts)) return false;

    let ext = getExt(url);
    if (!ext && item.filename) {
      const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(item.filename));
      if (m) ext = m[1].toLowerCase();
    }
    if (SKIP_EXTS.has(ext)) return false;

    const size = Number(item.totalBytes) > 0 ? Number(item.totalBytes) : 0;
    if (s.minSizeMB > 0 && size > 0 && size < s.minSizeMB * 1024 * 1024) return false;

    const mime = String(item.mime || '').toLowerCase();
    const mimeDownload = DOWNLOAD_MIME_PREFIXES.some((p) => mime.startsWith(p));
    return s.extensions.includes(ext) || mimeDownload || size > 1024 * 1024;
  }

  /** Remembers recently forwarded URLs so one download is never sent twice (several listeners / retries). */
  function createDedupe(ttlMs, now) {
    const clock = now || (() => Date.now());
    const seen = new Map();
    return {
      /** true if the key is new (and records it); false if it was seen within ttlMs. */
      firstSeen(key) {
        const t = clock();
        for (const [k, at] of seen) if (t - at > ttlMs) seen.delete(k);
        if (seen.has(key)) return false;
        seen.set(key, t);
        return true;
      },
    };
  }

  function parseFilename(contentDisp) {
    if (!contentDisp) return '';
    const rfc5987 = contentDisp.match(/filename\*\s*=\s*([^']+)'[^']*'([^;"\s]+)/i);
    if (rfc5987) { try { return decodeURIComponent(rfc5987[2]); } catch (e) { /* fall through */ } }
    const quoted = contentDisp.match(/filename\s*=\s*"([^"]+)"/i);
    if (quoted) return quoted[1].trim();
    const bare = contentDisp.match(/filename\s*=\s*([^;"\s]+)/i);
    return bare ? bare[1].trim() : '';
  }

  const api = { DEFAULT_SETTINGS, SKIP_EXTS, SKIP_HOSTS, getExt, hostOf, normalizeSettings,
    parseListInput, shouldIntercept, createDedupe, parseFilename };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NGCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
