// Run: node extension/tests/ng-core.test.js   (no dependencies; uses node:assert)
const assert = require('node:assert/strict');
const core = require('../chrome/ng-core.js');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const on = { interceptEnabled: true };

t('disabled by default', () => assert.equal(core.shouldIntercept({ url: 'https://a.com/x.zip' }, {}), false));
t('known extension intercepted', () => assert.equal(core.shouldIntercept({ url: 'https://a.com/x.zip' }, on), true));
t('web resources never intercepted', () => assert.equal(core.shouldIntercept({ url: 'https://a.com/app.js', totalBytes: 9e9 }, on), false));
t('blob/data/file never intercepted', () => {
  for (const u of ['blob:https://a/1', 'data:text/plain,x', 'file:///c:/x.zip']) assert.equal(core.shouldIntercept({ url: u }, on), false);
});
t('excluded host and its subdomains', () => {
  const s = { ...on, excludedHosts: ['example.com'] };
  assert.equal(core.shouldIntercept({ url: 'https://example.com/a.zip' }, s), false);
  assert.equal(core.shouldIntercept({ url: 'https://cdn.example.com/a.zip' }, s), false);
  assert.equal(core.shouldIntercept({ url: 'https://notexample.com/a.zip' }, s), true);
});
t('minimum size applies only when size is known', () => {
  const s = { ...on, minSizeMB: 10 };
  assert.equal(core.shouldIntercept({ url: 'https://a/x.zip', totalBytes: 5 * 1048576 }, s), false);
  assert.equal(core.shouldIntercept({ url: 'https://a/x.zip', totalBytes: 50 * 1048576 }, s), true);
  assert.equal(core.shouldIntercept({ url: 'https://a/x.zip', totalBytes: 0 }, s), true);
});
t('mime or big size without extension', () => {
  assert.equal(core.shouldIntercept({ url: 'https://a/dl?id=1', mime: 'application/octet-stream' }, on), true);
  assert.equal(core.shouldIntercept({ url: 'https://a/dl?id=1', totalBytes: 5e6 }, on), true);
  assert.equal(core.shouldIntercept({ url: 'https://a/dl?id=1', totalBytes: 10 }, on), false);
});
t('extension list is user-configurable', () => {
  const s = { ...on, extensions: ['zip'] };
  assert.equal(core.shouldIntercept({ url: 'https://a/x.pdf' }, s), false);
  assert.equal(core.shouldIntercept({ url: 'https://a/x.zip' }, s), true);
});
t('normalizeSettings sanitises input', () => {
  const s = core.normalizeSettings({ interceptEnabled: 'yes', minSizeMB: -5, extensions: ['.ZIP', '  ', 'a b'], excludedHosts: ['*.Foo.com'] });
  assert.equal(s.interceptEnabled, false);
  assert.equal(s.minSizeMB, 0);
  assert.deepEqual(s.extensions, ['zip']);
  assert.deepEqual(s.excludedHosts, ['foo.com']);
  assert.ok(core.normalizeSettings(null).extensions.length > 10);
});
t('parseListInput', () => assert.deepEqual(core.parseListInput('a, b;c\nd'), ['a', 'b', 'c', 'd']));
t('dedupe within ttl only', () => {
  let now = 0;
  const d = core.createDedupe(1000, () => now);
  assert.equal(d.firstSeen('u'), true);
  assert.equal(d.firstSeen('u'), false);
  now = 1500;
  assert.equal(d.firstSeen('u'), true);
});
t('parseFilename', () => {
  assert.equal(core.parseFilename('attachment; filename="a b.zip"'), 'a b.zip');
  assert.equal(core.parseFilename("attachment; filename*=UTF-8''a%20b.zip"), 'a b.zip');
  assert.equal(core.parseFilename('attachment; filename=x.bin'), 'x.bin');
  assert.equal(core.parseFilename(''), '');
});
console.log(`\n${n} extension logic tests passed`);
