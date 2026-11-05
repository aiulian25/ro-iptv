const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const client = path.resolve(__dirname, '..');
function bundle(file, resolveDir) {
  const code = buildSync({ stdin: { contents: fs.readFileSync(file, 'utf8'), resolveDir }, bundle: true, write: false, format: 'cjs', platform: 'node', alias: { '@shared': path.resolve(client, '../shared') } }).outputFiles[0].text;
  const context = { module: { exports: {} }, exports: {}, require }; vm.runInNewContext(code, context); return context.module.exports;
}
const { mergeGuides } = bundle(process.env.AUD018_MERGE_SOURCE || path.join(client, '../shared/normalize.js'), path.join(client, '../shared'));
const { findNowNext } = bundle(process.env.AUD018_CLIENT_SOURCE || path.join(client, 'src/lib/epg.js'), path.join(client, 'src/lib'));
const first = { title: 'One', start: '2026-07-01T12:00:00Z', stop: '2026-07-01T13:00:00Z', desc: '', endStatus: 'explicit' };
const second = { title: 'Two', start: '2026-07-01T13:00:00Z', stop: '2026-07-01T14:00:00Z' };
const guide = (...list) => ({ channels: { c: { name: 'News' } }, programmes: { c: list } });
const json = value => JSON.parse(JSON.stringify(value));
test('identical sources produce one airing and the actual following show as Next', () => {
  const merged = mergeGuides([guide(first, second), guide({ ...first }, { ...second })]);
  assert.equal(merged.programmes.c.length, 2);
  const result = findNowNext(merged.programmes.c, new Date('2026-07-01T12:30Z'));
  assert.equal(result.now.title, 'One'); assert.equal(result.next.title, 'Two');
});
test('later duplicate metadata fills gaps; first source wins conflicting nonempty fields', () => {
  const richer = { ...first, title: '  ONE  ', desc: 'Rich description', icon: 'https://logo.example/icon', category: 'News' };
  const result = mergeGuides([guide({ ...first, category: 'Current affairs' }), guide(richer)]).programmes.c[0];
  assert.equal(result.title, 'One'); assert.equal(result.desc, 'Rich description'); assert.equal(result.icon, richer.icon); assert.equal(result.category, 'Current affairs');
  assert.equal(mergeGuides([guide(richer), guide(first)]).programmes.c[0].title, '  ONE  ');
});
test('different channels, titles, editions and intervals remain distinct despite overlap', () => {
  const regional = { channels: { region: { name: 'News' } }, programmes: { region: [first] } };
  const result = mergeGuides([guide(first), guide({ ...first, title: 'Different' }, { ...first, title: 'One (Morning)' }, { ...first, stop: '2026-07-01T13:30Z' }), regional]);
  assert.equal(result.programmes.c.length, 4); assert.equal(result.programmes.region.length, 1);
});
test('title case/whitespace/unicode and equivalent normalized instants deduplicate without channel-name stripping', () => {
  const a = { ...first, title: 'Ｎｅｗｓ  Update' }, b = { ...first, title: 'news update', start: '2026-07-01T14:00:00+0200', stop: '2026-07-01T15:00:00+0200' };
  assert.equal(mergeGuides([guide(a), guide(b)]).programmes.c.length, 1);
  assert.equal(mergeGuides([guide({ ...first, title: 'News HD' }), guide({ ...first, title: 'News SD' })]).programmes.c.length, 2);
});
test('partial source overlap deduplicates only the repeated airing and sorts the union', () => {
  const third = { ...second, title: 'Three', start: '2026-07-01T14:00Z', stop: '2026-07-01T15:00Z' };
  assert.deepEqual(json(mergeGuides([guide(second, first), guide(third, second)]).programmes.c.map(p => p.title)), ['One', 'Two', 'Three']);
});
test('unknown ends deduplicate as points while coarse/precise or different end times stay distinct', () => {
  const unknown = { ...first, stop: null, endStatus: 'unknown' };
  assert.equal(mergeGuides([guide(unknown), guide({ ...unknown })]).programmes.c.length, 1);
  assert.equal(mergeGuides([guide(first), guide({ ...first, timeUncertain: true, startPrecision: 10 })]).programmes.c.length, 2);
  assert.equal(mergeGuides([guide(unknown), guide(first)]).programmes.c.length, 2);
});
test('missing identity evidence is preserved and input objects remain untouched', () => {
  const a = guide(first), b = guide({ ...first, desc: 'New' }); const before = JSON.stringify([a, b]);
  const merged = mergeGuides([a, b]); assert.equal(JSON.stringify([a, b]), before); assert.notEqual(merged.programmes.c[0], first);
  for (const invalid of [{ ...first, title: '' }, { ...first, start: 'bad' }, { ...first, stop: first.start }]) assert.equal(mergeGuides([guide(invalid), guide(invalid)]).programmes.c.length, 2);
});
test('Now/Next tolerates duplicate cached entries and skips conflicts overlapping the current airing', () => {
  const overlap = { ...first, title: 'Conflict', start: '2026-07-01T12:45Z', stop: '2026-07-01T13:15Z' };
  const result = findNowNext([first, { ...first }, overlap, second], new Date('2026-07-01T12:30Z'));
  assert.equal(result.now.title, 'One'); assert.equal(result.next.title, 'Two');
});
