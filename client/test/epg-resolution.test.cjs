const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const client = path.resolve(__dirname, '..');
function bundle(source, resolveDir) {
  const code = buildSync({ stdin: { contents: fs.readFileSync(source, 'utf8'), resolveDir }, bundle: true, write: false, format: 'cjs', platform: 'node', alias: { '@shared': path.resolve(client, '../shared') } }).outputFiles[0].text;
  const context = { module: { exports: {} }, exports: {}, require, console }; vm.runInNewContext(code, context); return context.module.exports;
}
const backend = bundle(process.env.AUD016_MATCH_SOURCE || path.join(client, '../server/lib/epgmatch.js'), path.join(client, '../server/lib'));
const frontend = bundle(process.env.AUD016_CLIENT_SOURCE || path.join(client, 'src/lib/epg.js'), path.join(client, 'src/lib'));
const programme = { title: 'Current schedule', start: '2026-11-05T12:00:00Z', stop: '2026-11-05T13:00:00Z' };
const guide = { channels: { exact: { name: 'Exact News' }, 'feed@SD': { name: 'Feed SD' }, feed: { name: 'Feed HD' }, metadata: { name: 'Metadata' }, empty: 'Empty', named: { name: 'Name News' } }, programmes: { exact: [programme], 'feed@SD': [programme], feed: [programme], empty: [], named: [programme], only: [programme] } };
const cases = [
  ['exact ID', { tvgId: 'exact' }, {}, {}, 'exact', 'tvgId', 'scheduled'],
  ['feed suffix fallback', { tvgId: 'exact@HD' }, {}, {}, 'exact', 'tvgId', 'scheduled'],
  ['exact feed wins', { tvgId: 'feed@SD' }, {}, {}, 'feed@SD', 'tvgId', 'scheduled'],
  ['normalized name', { name: 'Name News HD' }, {}, {}, 'named', 'name', 'scheduled'],
  ['alternative name', { name: 'Different' }, {}, { different: 'exact' }, 'exact', 'altName', 'scheduled'],
  ['invalid alternative name', { name: 'Different' }, {}, { different: 'gone' }, null, null, 'unmatched'],
  ['manual precedence', { tvgId: 'exact' }, { c: 'named' }, {}, 'named', 'override', 'scheduled'],
  ['missing manual target never auto-falls back', { tvgId: 'exact', name: 'Exact News' }, { c: 'gone' }, {}, null, 'override', 'missing-target'],
  ['metadata-only exact stays authoritative', { tvgId: 'metadata', name: 'Name News' }, {}, {}, 'metadata', 'tvgId', 'metadata-only'],
  ['empty schedule', { tvgId: 'empty' }, {}, {}, 'empty', 'tvgId', 'empty-schedule'],
  ['programmes without metadata', { tvgId: 'only' }, {}, {}, 'only', 'tvgId', 'scheduled'],
  ['manual metadata-only', {}, { c: 'metadata' }, {}, 'metadata', 'override', 'metadata-only'],
];
for (const [name, fields, overrides, alt, key, method, status] of cases) test('client/server resolution: ' + name, () => {
  const channel = { id: 'c', name: 'Unmatched', ...fields };
  const [result] = backend.matchAll([channel], guide, overrides, alt);
  assert.equal(result.matchedKey, key); assert.equal(result.method, method); assert.equal(result.status, status);
  assert.equal(result.hasProgrammes, status === 'scheduled');
  const actual = frontend.programmesForChannel(guide, channel, overrides, alt);
  assert.equal(JSON.stringify(actual), JSON.stringify(status === 'scheduled' ? [programme] : []));
  if (status === 'missing-target') assert.equal(result.targetKey, 'gone');
});
test('removed target remains missing even against an empty guide and incomplete legacy shape', () => {
  for (const guide of [{ channels: {}, programmes: {} }, { channels: {} }]) {
    const channel = { id: 'c', tvgId: 'gone' };
    assert.equal(backend.matchAll([channel], guide, { c: 'gone' })[0].matchedKey, null);
    assert.equal(frontend.programmesForChannel(guide, channel, { c: 'gone' }).length, 0);
  }
});
