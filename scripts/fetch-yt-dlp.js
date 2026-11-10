#!/usr/bin/env node
/**
 * Downloads the latest yt-dlp binary into src-tauri/resources/ so it is bundled into the
 * NetGuard installer, and VERIFIES it against the SHA2-256SUMS file published with the release
 * before it is allowed to stay on disk. yt-dlp is a separate program (Unlicense).
 *
 * Run manually: node scripts/fetch-yt-dlp.js      Or: npm run fetch-yt-dlp
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RESOURCES_DIR = path.join(__dirname, '..', 'src-tauri', 'resources');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ASSET = IS_WIN ? 'yt-dlp.exe' : IS_MAC ? 'yt-dlp_macos' : 'yt-dlp';
const BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';
const OUTPUT_FILE = path.join(RESOURCES_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'NetGuard-fetch-yt-dlp/1.0' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        res.resume();
        return get(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Parse "<sha256>  <filename>" lines and return the hash for `name`. */
function expectedHash(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

module.exports = { expectedHash };

if (require.main === module) {
  (async () => {
    fs.mkdirSync(RESOURCES_DIR, { recursive: true });
    if (fs.existsSync(OUTPUT_FILE) && fs.statSync(OUTPUT_FILE).size > 1_000_000) {
      console.log('yt-dlp already present, skipping download (delete src-tauri/resources/yt-dlp* to refresh).');
      return;
    }
    console.log(`Fetching ${ASSET} …`);
    const [bin, sums] = await Promise.all([get(BASE + ASSET), get(BASE + 'SHA2-256SUMS')]);
    const want = expectedHash(sums.toString('utf8'), ASSET);
    if (!want) throw new Error(`No checksum for ${ASSET} in SHA2-256SUMS`);
    const got = crypto.createHash('sha256').update(bin).digest('hex');
    if (got !== want) throw new Error(`Checksum mismatch for ${ASSET}: expected ${want}, got ${got}`);
    if (bin.length < 1_000_000) throw new Error('Downloaded file is implausibly small');
    fs.writeFileSync(OUTPUT_FILE, bin);
    if (!IS_WIN) fs.chmodSync(OUTPUT_FILE, 0o755);
    console.log(`Verified SHA-256 ${got}\nSaved to ${OUTPUT_FILE}`);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
