// Run: node --experimental-strip-types scripts/ui-logic.test.mts   (Node >= 22.6, no dependencies)
import assert from 'node:assert/strict'
import { formatBytes, formatSpeed, formatEta, formatSizeCell } from '../src/utils/format.ts'
import { MADE_BY, PRODUCT_NAME, versionLine } from '../src/branding.ts'

let n = 0
const t = (name: string, fn: () => void) => { fn(); n++; console.log('ok  ' + name) }

t('57% download shows downloaded / total, never "0 B"', () => {
  assert.equal(formatSizeCell(100 * 1048576, 57 * 1048576, 'downloading'), '57 MB / 100 MB')
})
t('idle item shows its total size', () => assert.equal(formatSizeCell(2048, 0, 'queued'), '2 KB'))
t('paused keeps size and progress bytes', () => assert.equal(formatSizeCell(2048, 1024, 'paused'), '1 KB / 2 KB'))
t('unknown size is reported as Unknown, with bytes so far', () => {
  assert.equal(formatSizeCell(-1, 0, 'queued'), 'Unknown')
  assert.equal(formatSizeCell(-1, 5 * 1048576, 'downloading'), '5 MB / Unknown')
  assert.equal(formatSizeCell(0, 0, 'downloading'), 'Unknown')
})
t('completed shows total, or received bytes when the server never said', () => {
  assert.equal(formatSizeCell(1048576, 1048576, 'completed'), '1 MB')
  assert.equal(formatSizeCell(-1, 3 * 1048576, 'completed'), '3 MB')
})
t('speed: real values formatted, stopped/invalid shown as dash', () => {
  assert.equal(formatSpeed(2 * 1048576), '2 MB/s')
  for (const v of [0, -5, 0.4, NaN, Infinity]) assert.equal(formatSpeed(v), '—')
})
t('eta formatting', () => {
  assert.equal(formatEta(59), '59s'); assert.equal(formatEta(125), '2m 5s'); assert.equal(formatEta(3700), '1h 1m')
  assert.equal(formatEta(0), '—'); assert.equal(formatEta(NaN), '—')
})
t('formatBytes edge cases', () => {
  assert.equal(formatBytes(0), '0 B'); assert.equal(formatBytes(0.5), '0 B'); assert.equal(formatBytes(-1), 'Unknown')
  assert.equal(formatBytes(1024 ** 5), '1024 TB')
})
t('branding: product name unchanged, author credit next to version', () => {
  assert.equal(PRODUCT_NAME, 'NetGuard Download Manager')
  assert.equal(MADE_BY, 'Made by Torik')
  assert.equal(versionLine('1.0.0'), 'v1.0.0 · Made by Torik')
})
console.log(`\n${n} UI logic tests passed`)
