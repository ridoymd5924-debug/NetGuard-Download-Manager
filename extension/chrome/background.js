/**
 * NetGuard Browser Extension - Background Service Worker v1.2.2
 *
 * Detects:
 *  - File downloads (zip, exe, pdf, etc.) via webRequest + downloads API
 *  - Video/audio streams including HLS (.m3u8), DASH (.mpd), progressive mp4, etc.
 *  - YouTube via googlevideo.com interception
 *  - Dynamic media via page-world injection messages
 */
// Shared pure logic. Chromium service workers load it here; the Firefox event page gets it from the
// manifest "scripts" list (which runs before this file).
if (typeof importScripts === 'function' && typeof globalThis.NGCore === 'undefined') {
  importScripts('ng-core.js');
}
const NG = globalThis.NGCore;
const IS_FIREFOX = typeof browser !== 'undefined' && !!(browser.runtime && browser.runtime.getBrowserInfo);
// Firefox rejects the Chromium-only "extraHeaders" option with a TypeError (which would stop the
// whole background script), Chromium needs it to see Cookie/Referer-type headers.
const EXTRA_HEADERS = IS_FIREFOX ? [] : ['extraHeaders'];
console.log('[NetGuard] background loaded at', new Date().toISOString());

const NG_PORT = 8597;
const NG_HOST = `http://127.0.0.1:${NG_PORT}`;
const NG_WS   = `ws://127.0.0.1:${NG_PORT}/ws`;
let isNgRunning = false;
let ngConfig = { enabled: true };
// Session token received from NetGuard on /sync. Persisted in chrome.storage.session
// so it survives brief service worker restarts within the same browser session.
let ngToken = null;
chrome.storage.session.get('ngToken').then(r => { if (r.ngToken) ngToken = r.ngToken; });

// Whether the extension should automatically intercept browser downloads.
// Default OFF — user must explicitly enable via popup toggle.
let interceptEnabled = false;
let ngSettings = NG.normalizeSettings({});
const settingsReady = chrome.storage.local.get(['ngSettings', 'interceptEnabled']).then(r => {
  // Older versions only stored the on/off flag; keep honouring it.
  const raw = r.ngSettings || { interceptEnabled: r.interceptEnabled === true };
  ngSettings = NG.normalizeSettings(raw);
  interceptEnabled = ngSettings.interceptEnabled;
}).catch(() => {});
// One download must never be forwarded twice (webRequest + downloads API + retries).
const recentlyForwarded = NG.createDedupe(15000);

// ── Shared YouTube cookie helper ──────────────────────────────────────────────
function isYtUrl(url) {
  return url && (url.includes('youtube.com') || url.includes('youtu.be'));
}
function fetchYtCookiesNetscape() {
  return chrome.cookies.getAll({ domain: 'youtube.com' }).then(cookies => {
    if (!cookies.length) return null;
    const lines = ['# Netscape HTTP Cookie File'];
    for (const c of cookies) {
      // Netscape format: domain must start with '.' and include_subdomains must match.
      // Python's http.cookiejar asserts: (flag == "TRUE") === domain.startsWith('.')
      // We always use a dot-prefixed domain, so flag is always TRUE.
      const domain = c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
      const sub    = 'TRUE';
      const secure = c.secure ? 'TRUE' : 'FALSE';
      const exp    = c.expirationDate ? Math.round(c.expirationDate) : '0';
      lines.push([domain, sub, c.path, secure, exp, c.name, c.value].join('\t'));
    }
    return lines.join('\n');
  }).catch(() => null);
}

// ── WebSocket connection to NetGuard desktop ───────────────────────────────────────
let ws = null;
let wsRetry = 0;
let wsPing = null;

function connectWs() {
  if (ws && ws.readyState < 2) return; // already open or connecting
  try {
    ws = new WebSocket(NG_WS);
    ws.onopen = () => {
      isNgRunning = true;
      wsRetry = 0;
      updateBadge();
      flushOutboundQueue();
      // Traffic every 20 s keeps the Chromium service worker alive while connected.
      clearInterval(wsPing);
      wsPing = setInterval(() => { try { ws && ws.readyState === 1 && ws.send('ping'); } catch {} }, 20000);
    };
    ws.onclose  = () => {
      ws = null; isNgRunning = false; clearInterval(wsPing); updateBadge();
      // Quick reconnect with capped backoff; the alarm below is the safety net if the worker dies.
      const delay = Math.min(30000, 1000 * Math.pow(2, wsRetry++));
      setTimeout(connectWs, delay);
    };
    ws.onerror  = () => {};
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleWsPush(msg);
      } catch {}
    };
  } catch { ws = null; }
}

function handleWsPush(msg) {
  if (msg.type === 'status') {
    isNgRunning = true;
    updateBadge(msg.mediaCount);
  }
  if (msg.type === 'media_added') {
    updateBadge(msg.mediaCount);
  }
  if (msg.type === 'download_complete') {
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Download Complete',
      message: msg.fileName || 'File downloaded',
    });
  }
}

function updateBadge(mediaCount) {
  const text = isNgRunning ? (mediaCount > 0 ? String(mediaCount) : '') : '!';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: isNgRunning ? '#257eff' : '#e17055' });
}

// Initial connection attempt
connectWs();

// requestId → { requestHeaders, tabId, timeStamp }
const requestMap = new Map();

// requestId → original URL (before any redirect chain)
const redirectMap = new Map();

// tabId → [{ url, file, quality, contentType, headers, cookie }]  (for banner clicks)
const capturedByTab = new Map();

// ── Canonical URL for deduplication ───────────────────────────────────────────
// YouTube googlevideo URLs carry rotating expire/sig tokens — strip them so the
// same video at the same quality is not added twice.
function canonicalUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('googlevideo') || u.hostname.includes('youtube.com')) {
      // Strip rotating tokens; keep itag (quality selector)
      ['expire','sig','lmt','ratebypass','ip','ipbits','id','source','key','sparams','rbuf'].forEach(k =>
        u.searchParams.delete(k));
    }
    // Strip generic cache-busting params
    ['_','t','cb','rand','cache','ts','nocache','v'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return url;
  }
}

function storeTabMedia(tabId, item) {
  if (tabId <= 0) return;
  if (!capturedByTab.has(tabId)) capturedByTab.set(tabId, []);
  const list = capturedByTab.get(tabId);
  const key = canonicalUrl(item.url);
  if (list.find(m => canonicalUrl(m.url) === key)) return;
  if (list.length >= 30) list.shift();
  list.push(item);
}

// ── Outbound request queue ─────────────────────────────────────────────────────
// Buffers requests while NetGuard is temporarily unavailable (e.g. restarting).
// Flushed on every alarm tick.
const outboundQueue = []; // { endpoint, data, retries }

async function flushOutboundQueue() {
  if (!isNgRunning || outboundQueue.length === 0) return;
  while (outboundQueue.length > 0) {
    const item = outboundQueue[0];
    const ok = await sendToNG(item.endpoint, item.data);
    if (ok) {
      outboundQueue.shift();
    } else if (item.retries >= 3) {
      outboundQueue.shift(); // discard after 3 failures
    } else {
      item.retries++;
      break; // stop flushing until next alarm
    }
  }
}

function getBestForTab(tabId) {
  const items = capturedByTab.get(tabId) || [];
  if (!items.length) return null;
  // Prefer video streams over audio-only
  const videos = items.filter(m => (m.contentType || '').startsWith('video/'));
  return videos.length ? videos[videos.length - 1] : items[items.length - 1];
}

// ── File type sets ─────────────────────────────────────────────────────────────

const DOWNLOAD_EXTS = new Set([
  'zip','rar','7z','tar','gz','bz2','xz','zst','cab',
  'exe','msi','dmg','deb','rpm','appimage','apk',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'iso','img','bin','torrent','epub','mobi','azw3',
]);

const MEDIA_EXTS = new Set([
  'mp4','mkv','webm','avi','mov','flv','m4v','wmv',
  'mp3','flac','wav','aac','ogg','wma','m4a','opus',
]);

// HLS/DASH/streaming manifests — always capture, size doesn't matter
const STREAM_EXTS = new Set(['m3u8','mpd','f4m']);

// Skip these — they're web page resources or encrypted/undecodable blobs
const SKIP_EXTS = new Set([
  'html','htm','php','asp','aspx','jsp',
  'js','mjs','cjs','css','scss','less',
  'json','xml','svg','woff','woff2','ttf','eot',
  'ico','cur','map','webmanifest','ts',   // .ts = TypeScript, not MPEG-TS here
  // Encrypted / DRM-protected blobs — NetGuard cannot decrypt these
  'enc','crypt','crypt12','crypt14','crypt15', // WhatsApp encrypted media
  'aes','drm','wvd',
]);

// Skip requests originating from these hosts — chat apps, auth flows, etc.
const SKIP_HOSTS = new Set([
  'mmg.whatsapp.net','media.whatsapp.net','static.whatsapp.net',
  'web.whatsapp.com',
  'cdn4.telegram-cdn.org','cdn1.telegram-cdn.org',
  'accounts.google.com','oauth2.googleapis.com',
  'login.microsoftonline.com',
]);

const SKIP_CONTENT_TYPES = new Set([
  'text/html','text/css','text/javascript','application/javascript',
  'application/json','text/xml','application/xml',
  'image/svg+xml','font/woff','font/woff2',
  'application/x-javascript','text/ecmascript',
]);

const DOWNLOAD_CONTENT_TYPES = [
  'application/octet-stream',
  'application/zip','application/x-rar','application/x-rar-compressed',
  'application/x-7z-compressed','application/gzip','application/x-tar',
  'application/pdf',
  'application/x-msdownload','application/x-msi','application/x-ms-installer',
  'application/x-apple-diskimage',
  'application/vnd.android.package-archive',
  'application/x-bittorrent',
];

// HLS / DASH / streaming MIME types — IDM captures all of these
const STREAM_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',     // HLS — most common
  'application/x-mpegurl',             // HLS alternate
  'audio/mpegurl',                     // HLS audio
  'audio/x-mpegurl',                   // HLS audio alternate
  'video/mpegurl',                     // HLS video
  'application/dash+xml',              // MPEG-DASH
  'video/vnd.mpeg.dash.mpd',           // DASH alternate
  'application/f4m+xml',               // Adobe HDS
  'application/vnd.ms-sstr+xml',       // Microsoft Smooth Streaming
  'application/vnd.ms-playready.initiator+xml',
]);

// YouTube video streaming host patterns
const YT_HOSTS = ['googlevideo.com', 'youtube.com/videoplayback'];

// ── NetGuard sync ───────────────────────────────────────────────────────────────────

// Fallback HTTP sync — used when WS is unavailable or to fetch full config
async function syncWithNG() {
  try {
    const res = await fetch(`${NG_HOST}/sync`, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      ngConfig = data;
      isNgRunning = true;
      if (data.token && data.token !== ngToken) {
        ngToken = data.token;
        chrome.storage.session.set({ ngToken });
      }
    } else {
      isNgRunning = false;
    }
  } catch {
    isNgRunning = false;
  }
  updateBadge();
}

/** After a worker/event-page restart isNgRunning is false until the socket reconnects. */
async function ensureConnected() {
  if (isNgRunning) return true;
  await syncWithNG();
  if (isNgRunning) connectWs();
  return isNgRunning;
}

// Alarm: keep service worker alive and reconnect WebSocket if it drops
// Browsers clamp alarms to a minimum period (Chromium 30 s, Firefox 1 min); a smaller value is
// silently raised, so ask for what is actually honoured.
chrome.alarms.create('ng-sync', { periodInMinutes: IS_FIREFOX ? 1 : 0.5 });
chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === 'ng-sync') {
    if (!ws || ws.readyState > 1) {
      // WS is closed/closing — try reconnect
      connectWs();
      if (!isNgRunning) {
        // Also try HTTP fallback in case WS connect fails immediately
        await syncWithNG();
      }
    }
    flushOutboundQueue();
  }
});

async function sendToNG(endpoint, data, { queue = false } = {}) {
  if (!isNgRunning) {
    if (queue) outboundQueue.push({ endpoint, data, retries: 0 });
    return false;
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ngToken) headers['X-NetGuard-Token'] = ngToken;
    const res = await fetch(`${NG_HOST}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) {
      // Token mismatch — NetGuard restarted. Re-sync to get new token.
      await syncWithNG();
    }
    return res.ok;
  } catch {
    if (queue) outboundQueue.push({ endpoint, data, retries: 0 });
    return false;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getHeader(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  const h = headers.find(x => x.name.toLowerCase() === lower);
  return h?.value || null;
}

function getExt(url) {
  try {
    const path = new URL(url).pathname;
    const lastDot = path.lastIndexOf('.');
    if (lastDot > 0) {
      const ext = path.substring(lastDot + 1).toLowerCase().split(/[?#]/)[0];
      if (ext.length <= 10) return ext;
    }
  } catch {}
  return '';
}

// Parse filename from Content-Disposition header
// Handles both:
//   Content-Disposition: attachment; filename="foo.zip"
//   Content-Disposition: attachment; filename*=UTF-8''foo%20bar.zip
function parseFilename(contentDisp) {
  if (!contentDisp) return '';
  // RFC 5987 — filename*=charset''encoded
  const rfc5987 = contentDisp.match(/filename\*\s*=\s*([^']+)'[^']*'([^;"\s]+)/i);
  if (rfc5987) {
    try { return decodeURIComponent(rfc5987[2]); } catch {}
  }
  // Standard filename="..."
  const standard = contentDisp.match(/filename\s*=\s*"([^"]+)"/i);
  if (standard) return standard[1].trim();
  // Unquoted filename=...
  const unquoted = contentDisp.match(/filename\s*=\s*([^;"\s]+)/i);
  if (unquoted) return unquoted[1].trim();
  return '';
}

// Get cookies for a URL via the cookies API
async function getCookiesForUrl(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length === 0) return undefined;
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch { return undefined; }
}

// ── Request classification ─────────────────────────────────────────────────────

function classifyRequest(url, responseHeaders) {
  const ext = getExt(url);
  const contentType = (getHeader(responseHeaders, 'content-type') || '').toLowerCase().split(';')[0].trim();
  const contentLength = parseInt(getHeader(responseHeaders, 'content-length') || '0');
  const contentDisp = getHeader(responseHeaders, 'content-disposition') || '';
  const urlLower = url.toLowerCase();

  // Always skip web resources and blocked hosts
  if (SKIP_EXTS.has(ext)) return null;
  try {
    const host = new URL(url).hostname;
    if (SKIP_HOSTS.has(host)) return null;
  } catch {}
  if (SKIP_CONTENT_TYPES.has(contentType)) return null;
  if (contentType.startsWith('text/') && !contentType.includes('mpegurl')) return null;
  if (contentType.startsWith('image/') && contentLength < 5 * 1024 * 1024) return null;
  if (contentType.startsWith('font/') || contentType.startsWith('application/font')) return null;

  // ── 1. HLS / DASH / streaming manifests — highest priority ──────────────────
  if (STREAM_CONTENT_TYPES.has(contentType)) {
    return { type: 'media', reason: 'stream', streamType: getStreamType(contentType, ext) };
  }
  if (STREAM_EXTS.has(ext)) {
    return { type: 'media', reason: 'stream', streamType: ext === 'mpd' ? 'dash' : ext === 'f4m' ? 'hds' : 'hls' };
  }

  // ── 2. YouTube / googlevideo ─────────────────────────────────────────────────
  if (YT_HOSTS.some(h => urlLower.includes(h))) {
    // Match /videoplayback, mime=video, mime=audio (plain and URL-encoded)
    if (urlLower.includes('/videoplayback') ||
        urlLower.includes('mime=video') || urlLower.includes('mime=audio') ||
        urlLower.includes('mime%3dvideo') || urlLower.includes('mime%3daudio') ||
        urlLower.includes('mime%3Dvideo') || urlLower.includes('mime%3Daudio')) {
      return { type: 'media', reason: 'youtube' };
    }
    return null;
  }

  // ── 3. Content-Disposition: attachment ──────────────────────────────────────
  if (contentDisp.toLowerCase().includes('attachment')) {
    return { type: 'download', reason: 'attachment', filename: parseFilename(contentDisp) };
  }

  // ── 4. Known download file extensions ───────────────────────────────────────
  if (DOWNLOAD_EXTS.has(ext)) {
    return { type: 'download', reason: 'ext' };
  }

  // ── 5. Known media file extensions (need substantial size or unknown size) ──
  if (MEDIA_EXTS.has(ext)) {
    if (contentLength === 0 || contentLength > 500 * 1024) {
      return { type: 'media', reason: 'ext' };
    }
    return null;
  }

  // ── 6. Download MIME types ───────────────────────────────────────────────────
  if (DOWNLOAD_CONTENT_TYPES.some(t => contentType.startsWith(t) || contentType === t)) {
    if (contentLength === 0 || contentLength > 10 * 1024) {
      return { type: 'download', reason: 'content-type' };
    }
    return null;
  }

  // ── 7. Video / audio MIME types (not HLS/DASH — already handled) ────────────
  if (contentType.startsWith('video/') || contentType.startsWith('audio/')) {
    if (contentLength === 0 || contentLength > 500 * 1024) {
      return { type: 'media', reason: 'content-type' };
    }
    return null;
  }

  return null;
}

function getStreamType(contentType, ext) {
  if (contentType.includes('dash') || contentType.includes('mpd') || ext === 'mpd') return 'dash';
  if (contentType.includes('f4m') || ext === 'f4m') return 'hds';
  if (contentType.includes('sstr') || contentType.includes('playready')) return 'smooth';
  return 'hls';
}

// ── YouTube quality from itag ──────────────────────────────────────────────────

const YT_ITAG = {
  '18':'360p','22':'720p','37':'1080p','38':'4K',
  '133':'240p','134':'360p','135':'480p','136':'720p','137':'1080p','138':'4K','160':'144p',
  '264':'1440p','266':'2160p','298':'720p60','299':'1080p60','303':'1080p60',
  '308':'1440p60','315':'2160p60',
  '242':'240p VP9','243':'360p VP9','244':'480p VP9','247':'720p VP9',
  '248':'1080p VP9','271':'1440p VP9','313':'2160p VP9',
  '302':'720p60 VP9','303':'1080p60 VP9','308':'1440p60 VP9','315':'2160p60 VP9',
  '394':'144p AV1','395':'240p AV1','396':'360p AV1','397':'480p AV1',
  '398':'720p AV1','399':'1080p AV1','400':'1440p AV1','401':'2160p AV1',
  '139':'48kbps','140':'128kbps','141':'256kbps',
  '249':'Opus 50k','250':'Opus 70k','251':'Opus 160k',
  '171':'Vorbis 128k',
};

function getYouTubeQuality(url) {
  try {
    const u = new URL(url);
    const itag = u.searchParams.get('itag');
    const mime = (u.searchParams.get('mime') || '').toLowerCase();
    if (itag && YT_ITAG[itag]) return YT_ITAG[itag];
    if (mime.includes('video')) return itag ? `Video #${itag}` : 'Video';
    if (mime.includes('audio')) return itag ? `Audio #${itag}` : 'Audio';
    return itag ? `#${itag}` : '';
  } catch { return ''; }
}

// ── WebRequest listeners ───────────────────────────────────────────────────────

// Capture request headers so we can include them in the payload
chrome.webRequest.onSendHeaders.addListener(
  (info) => {
    if (!isNgRunning) return;
    requestMap.set(info.requestId, { requestHeaders: info.requestHeaders, tabId: info.tabId, timeStamp: info.timeStamp });
    // Trim old entries
    if (requestMap.size > 500) {
      const cutoff = Date.now() - 60000;
      for (const [id, r] of requestMap) { if (r.timeStamp < cutoff) requestMap.delete(id); }
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['requestHeaders', ...EXTRA_HEADERS]
);

// Track redirect chains so we can use the original URL as Referer
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.type === 'main_frame' || details.type === 'sub_frame') return;
    // Store the earliest URL in the redirect chain
    if (!redirectMap.has(details.requestId)) {
      redirectMap.set(details.requestId, details.url);
    }
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  async (res) => {
    if (!isNgRunning) return;
    if (res.type === 'main_frame' || res.type === 'sub_frame') return;

    const req = requestMap.get(res.requestId);
    requestMap.delete(res.requestId);
    const originalUrl = redirectMap.get(res.requestId);
    redirectMap.delete(res.requestId);

    const result = classifyRequest(res.url, res.responseHeaders);
    if (!result) return;

    // Build header maps
    const requestHeaders = {};
    const cookiesFromReq = [];
    if (req?.requestHeaders) {
      for (const h of req.requestHeaders) {
        if (h.name.toLowerCase() === 'cookie') cookiesFromReq.push(h.value);
        else requestHeaders[h.name] = h.value;
      }
    }

    // Total file size — use Content-Range for chunked responses (YouTube)
    let size = parseInt(getHeader(res.responseHeaders, 'content-length') || '0');
    const contentRange = getHeader(res.responseHeaders, 'content-range') || '';
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)/);
      if (m) size = parseInt(m[1]);
    }

    const contentDisp = getHeader(res.responseHeaders, 'content-disposition') || '';
    const contentType = (getHeader(res.responseHeaders, 'content-type') || '').split(';')[0].trim();

    const data = {
      url: res.url,
      file: result.filename || parseFilename(contentDisp) || '',
      method: 'GET',
      requestHeaders,
      contentType,
      contentLength: size,
      tabUrl: '',
      tabId: (res.tabId || -1).toString(),
    };

    if (result.reason === 'youtube') {
      data.quality = getYouTubeQuality(res.url);
    }
    if (result.streamType) {
      data.streamType = result.streamType;
    }

    // Cookies: prefer cookie jar over request header
    const cookieJar = await getCookiesForUrl(res.url);
    data.cookie = cookieJar || (cookiesFromReq.length ? cookiesFromReq.join('; ') : undefined);

    // Tab info for filename, title and referer
    const finalize = async (tab) => {
      if (tab) {
        if (!data.file) data.file = tab.title || '';
        data.tabUrl = tab.url || '';
        data.tabTitle = tab.title || '';
        if (data.tabUrl) requestHeaders['Referer'] = data.tabUrl;
      }
      // If the final URL was reached via redirects, the original URL is the real Referer
      if (originalUrl && !requestHeaders['Referer']) {
        requestHeaders['Referer'] = originalUrl;
      }
      // YouTube CDN URLs (googlevideo.com) require auth tokens and expire quickly.
      // Substitute the watch URL so yt-dlp handles it, and collect the user's
      // YouTube session cookies from the browser jar right now (service worker
      // has full cookies API access) so yt-dlp can authenticate.
      if (result.reason === 'youtube' && data.tabUrl) {
        const t = data.tabUrl;
        if (t.includes('youtube.com/watch') || t.includes('youtube.com/shorts/') ||
            t.includes('youtube.com/live/') || t.includes('youtu.be/')) {
          data.url = data.tabUrl;
          data.quality = '';
          try {
            const ytCookies = await chrome.cookies.getAll({ url: 'https://www.youtube.com' });
            if (ytCookies.length) {
              data.cookie = ytCookies.map(c => `${c.name}=${c.value}`).join('; ');
            }
          } catch {}
        }
      }
      // Only media streams are reported from here. Ordinary file downloads are taken over in
      // exactly one place (downloads.onCreated), which also cancels the browser's own copy;
      // sending them from here as well produced duplicates and a double download.
      if (result.type === 'media') sendToNG('/media', data, { queue: true });

      // Store per-tab for banner clicks
      if (result.type === 'media' && res.tabId > 0) {
        storeTabMedia(res.tabId, {
          url: data.url, file: data.file, quality: data.quality || '',
          contentType, headers: requestHeaders, cookie: data.cookie,
        });
        // Notify content.js so it can show the banner
        chrome.tabs.sendMessage(res.tabId, { action: 'media-captured', quality: data.quality || '' },
          () => { chrome.runtime.lastError; }); // suppress "no listener" error
      }
    };

    if (res.tabId && res.tabId > 0) {
      chrome.tabs.get(res.tabId, (tab) => { finalize(chrome.runtime.lastError ? null : tab); });
    } else {
      finalize(null);
    }
  },
  { urls: ['http://*/*', 'https://*/*'] },
  ['responseHeaders', ...EXTRA_HEADERS]
);

chrome.webRequest.onErrorOccurred.addListener(
  (info) => { requestMap.delete(info.requestId); redirectMap.delete(info.requestId); },
  { urls: ['http://*/*', 'https://*/*'] }
);

// ── Browser downloads API interception ────────────────────────────────────────

chrome.downloads.onCreated.addListener(async (item) => {
  await settingsReady;
  if (!interceptEnabled) return;
  if (!NG.shouldIntercept({ url: item.url, mime: item.mime, totalBytes: item.totalBytes, filename: item.filename }, ngSettings)) return;
  if (!(await ensureConnected())) return;            // NetGuard not running: let the browser download normally
  if (!recentlyForwarded.firstSeen(NG.getExt(item.url) + '|' + item.url)) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [null]);
  const cookie = await getCookiesForUrl(item.url);
  // Hand over first; only cancel the browser's copy once NetGuard has accepted the job, so a
  // failed hand-over never loses the download.
  const ok = await sendToNG('/download', {
    url: item.url,
    file: item.filename ? item.filename.split(/[/\\]/).pop() : '',
    // The page that actually linked to the file (used as Referer) beats "whatever tab is active".
    tabUrl: item.referrer || tab?.url || '',
    tabId: (tab?.id || -1).toString(),
    contentType: item.mime || '',
    contentLength: item.totalBytes || 0,
    cookie,
  });
  if (ok) {
    try { await chrome.downloads.cancel(item.id); } catch {}
    try { await chrome.downloads.erase({ id: item.id }); } catch {}
  }
});

// ── SPA navigation tracking (YouTube, etc.) ───────────────────────────────────

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (!isNgRunning || details.frameId !== 0) return;
  sendToNG('/tab-update', {
    tabId: details.tabId.toString(),
    tabUrl: details.url,
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isNgRunning) return;
  if (changeInfo.title && tab.url) {
    sendToNG('/tab-update', { tabUrl: tab.url, tabTitle: changeInfo.title, tabId: tabId.toString() });
  }
});

// ── Context menu ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ng-link', title: 'Download with NetGuard ⚡', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'ng-media', title: 'Download media with NetGuard ⚡', contexts: ['video', 'audio'] });
  chrome.contextMenus.create({ id: 'ng-image', title: 'Download image with NetGuard ⚡', contexts: ['image'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.linkUrl || info.srcUrl;
  if (!url) return;
  if (!recentlyForwarded.firstSeen('ctx|' + url)) return;
  await ensureConnected();
  const cookie = await getCookiesForUrl(url);
  const endpoint = (info.mediaType === 'video' || info.mediaType === 'audio') ? '/media' : '/download';
  sendToNG(endpoint, {
    url,
    file: '',
    tabUrl: tab?.url || '',
    tabId: (tab?.id || -1).toString(),
    cookie,
    requestHeaders: tab?.url ? { Referer: tab.url } : {},
  });
});

// ── Messages from content script / popup ──────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'get-status') {
    syncWithNG().then(() => {
      sendResponse({ running: isNgRunning, config: ngConfig, interceptEnabled });
    });
    return true;
  }

  if (msg.action === 'set-intercept') {
    ngSettings = NG.normalizeSettings({ ...ngSettings, interceptEnabled: !!msg.enabled });
    interceptEnabled = ngSettings.interceptEnabled;
    chrome.storage.local.set({ ngSettings, interceptEnabled });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'get-settings') {
    settingsReady.then(() => sendResponse({ settings: ngSettings }));
    return true;
  }

  if (msg.action === 'set-settings') {
    // The on/off switch has its own control; a settings save must not flip it.
    ngSettings = NG.normalizeSettings({ interceptEnabled: ngSettings.interceptEnabled, ...msg.settings });
    interceptEnabled = ngSettings.interceptEnabled;
    chrome.storage.local.set({ ngSettings, interceptEnabled });
    sendResponse({ ok: true, settings: ngSettings });
    return true;
  }

  if (msg.action === 'get-yt-cookies') {
    fetchYtCookiesNetscape().then(ytdlpCookies => sendResponse({ ytdlpCookies }));
    return true; // keep channel open for async response
  }

  // Banner click in content.js — find best captured URL for this tab and download it
  if (msg.action === 'banner-download') {
    const tabId = sender.tab?.id;
    const item = tabId ? getBestForTab(tabId) : null;
    if (item && isNgRunning) {
      (isYtUrl(item.url) ? fetchYtCookiesNetscape() : Promise.resolve(null)).then(ytdlpCookies => {
        sendToNG('/vid', { url: item.url, file: item.file || '', tabUrl: sender.tab?.url || '', ytdlpCookies });
        sendResponse({ found: true, url: item.url });
      });
    } else {
      sendResponse({ found: false });
    }
    return true;
  }

  if (msg.action === 'download-video') {
    (isYtUrl(msg.url) ? fetchYtCookiesNetscape() : Promise.resolve(null)).then(ytdlpCookies => {
      sendToNG('/vid', { url: msg.url, file: msg.file || '', tabUrl: msg.tabUrl || '', ytdlpCookies });
    });
    return true;
  }
  if (msg.action === 'clear-videos') {
    sendToNG('/clear', {});
    return true;
  }
  if (msg.action === 'batch-links') {
    sendToNG('/link', { urls: (msg.links || []).map(l => l.url) });
    return true;
  }
  // Page-world media detection (from inject.js via content.js)
  if (msg.action === 'page-media') {
    const { url, title, mimeType, size, tabUrl } = msg;
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return true;
    getCookiesForUrl(url).then(cookie => {
      sendToNG('/media', {
        url,
        file: title || '',
        contentType: mimeType || '',
        contentLength: size || 0,
        tabUrl: tabUrl || sender.tab?.url || '',
        tabId: (sender.tab?.id || -1).toString(),
        cookie,
      });
    });
    return true;
  }
  return false;
});
