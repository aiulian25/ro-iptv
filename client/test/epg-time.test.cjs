const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const client = path.resolve(__dirname, '..');
const code = buildSync({ stdin: { contents: fs.readFileSync(process.env.AUD017_CLIENT_SOURCE || path.join(client, 'src/lib/epg.js'), 'utf8'), resolveDir: path.join(client, 'src/lib') }, bundle: true, write: false, format: 'cjs', platform: 'node', alias: { '@shared': path.resolve(client, '../shared') } }).outputFiles[0].text;
const context = { module: { exports: {} }, exports: {}, require }; vm.runInNewContext(code, context);
const epg = context.module.exports;
const unknown = { title: 'Unknown', start: '2026-07-01T12:00:00.000Z', stop: null, endStatus: 'unknown' };
test('unknown end never becomes Now or a guessed progress/duration; future entry remains Next', () => {
  assert.equal(epg.findNowNext([unknown], new Date('2026-07-01T12:30:00Z')).now, null);
  assert.equal(epg.findNowNext([unknown], new Date('2026-07-01T11:30:00Z')).next.title, 'Unknown');
  assert.equal(epg.progressPct(unknown), 0); assert.equal(epg.canScheduleProgramme(unknown), false);
  assert.match(epg.fmtProgrammeTime(unknown), /End unknown/);
});
test('unknown ends are visible as start points within the window and do not live forever', () => {
  assert.equal(epg.programmeInWindow(unknown, Date.parse('2026-07-01T11:00Z'), Date.parse('2026-07-01T13:00Z')), true);
  assert.equal(epg.programmeInWindow(unknown, Date.parse('2026-07-02T11:00Z'), Infinity), false);
});
test('inferred ends support Now/Next and recording while coarse or invalid intervals cannot schedule', () => {
  const inferred = { ...unknown, stop: '2026-07-01T13:00Z', endStatus: 'inferred' };
  assert.equal(epg.canScheduleProgramme(inferred), true);
  assert.equal(epg.findNowNext([inferred], new Date('2026-07-01T12:30Z')).now.title, 'Unknown');
  for (const p of [{ ...inferred, timeUncertain: true }, { ...inferred, stop: inferred.start }, { ...inferred, stop: 'bad' }]) assert.equal(epg.canScheduleProgramme(p), false);
  assert.equal(epg.findNowNext([{ ...inferred, timeUncertain: true }], new Date('2026-07-01T12:30Z')).now, null);
});
