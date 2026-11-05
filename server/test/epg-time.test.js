import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseGuideOffThread } from '../lib/epgparse.js';
const moduleUrl = process.env.AUD017_PARSER_SOURCE ? pathToFileURL(process.env.AUD017_PARSER_SOURCE).href : new URL('../lib/epg.js', import.meta.url).href;
const { parseEPG } = await import(moduleUrl);
const row = (start, stop, title = 'Fixture', channel = 'c') => `<programme channel="${channel}" start="${start}"${stop === undefined ? '' : ` stop="${stop}"`}><title>${title}</title></programme>`;
for (const zone of ['UTC', 'Europe/London', 'Europe/Bucharest']) test('UTC/default and offsets are host-independent in ' + zone, () => {
  const samples = ['20260701120000', '20260329013000', '20261025013000', '202401152030', '20260701120000 +0300', '20260101003000 +0200', '202607281733 BST'];
  const xml = '<tv>' + samples.map((value, i) => row(value, undefined, String(i), String(i))).join('') + '</tv>';
  const script = `import {parseEPG} from ${JSON.stringify(moduleUrl)};console.log(JSON.stringify(Object.values(parseEPG(${JSON.stringify(xml)}).programmes).map(list=>list[0].start)))`;
  const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' }));
  assert.deepEqual(actual, ['2026-07-01T12:00:00.000Z', '2026-03-29T01:30:00.000Z', '2026-10-25T01:30:00.000Z', '2024-01-15T20:30:00.000Z', '2026-07-01T09:00:00.000Z', '2025-12-31T22:30:00.000Z', '2026-07-28T16:33:00.000Z']);
});
test('complete leading fields retain precision; precise minutes/seconds remain schedulable', () => {
  for (const stamp of ['2026', '202607', '20260701', '2026070112', '202607011230', '20260701123045']) {
    const entry = parseEPG('<tv>' + row(stamp) + '</tv>').programmes.c[0];
    assert.equal(entry.startPrecision, stamp.length); assert.equal(entry.timeUncertain, stamp.length < 12);
    assert.equal(entry.stop, null); assert.equal(entry.endStatus, 'unknown');
  }
});
test('missing stops infer only safe following starts and preserve terminal unknowns', () => {
  const result = parseEPG('<tv>' + row('20260701110000', undefined, 'Next') + row('20260701100000', undefined, 'First') + row('20260701120000', '20260701130000', 'Explicit') + row('20260701140000', undefined, 'Terminal') + '</tv>').programmes.c;
  assert.deepEqual(result.map(p => p.endStatus), ['inferred', 'inferred', 'explicit', 'unknown']);
  assert.equal(result[0].stop, result[1].start); assert.equal(result[1].stop, result[2].start); assert.equal(result[3].stop, null);
});
test('duplicate starts and overlapping explicit intervals do not create guessed ends', () => {
  const result = parseEPG('<tv>' + row('20260701090000', '20260701120000', 'Overlap') + row('20260701100000', undefined, 'Unknown') + row('20260701110000', undefined, 'Clump A') + row('20260701110000', undefined, 'Clump B') + row('20260701130000', undefined, 'Later') + '</tv>').programmes.c;
  assert.equal(result[0].stop, '2026-07-01T12:00:00.000Z');
  assert.ok(result.slice(1).every(p => p.stop === null));
});
test('invalid calendar/clock/offset/trailing text and inverted intervals are rejected with one bounded diagnostic', () => {
  const warnings = []; const previous = console.warn; console.warn = text => warnings.push(text);
  try {
    const invalid = ['20260230100000', '20260229100000', '20261301100000', '20260701240000', '20260701106000', '20260701120060', '20260701120000 +2460', '20260701120000 +0260', '20260701120000 CST', '20260701120000 trailing', '202607011'];
    const xml = '<tv>' + invalid.map(value => row(value)).join('') + row('20260701100000', '20260701090000') + row('20260701100000', '') + row('20260701100000', '20260701100000') + row('20240229100000', undefined, 'Leap day') + '</tv>';
    const result = parseEPG(xml).programmes.c;
    assert.equal(result.length, 1); assert.equal(result[0].title, 'Leap day'); assert.equal(warnings.length, 1); assert.match(warnings[0], /14 invalid programme/);
    assert.ok(warnings[0].length < 100); assert.ok(!warnings[0].includes('CST'));
  } finally { console.warn = previous; }
});
test('invalid intermediate record and coarse following times block inference across uncertain gaps', () => {
  const result = parseEPG('<tv>' + row('20260701100000') + row('20260701110000', 'bad') + row('20260701120000') + '</tv>').programmes.c;
  assert.equal(result[0].stop, null);
  assert.equal(parseEPG('<tv>' + row('20260701100000') + row('2026070112') + '</tv>').programmes.c[0].stop, null);
});
test('worker path serves the same normalized missing-stop contract', async () => {
  const guide = await parseGuideOffThread(Buffer.from('<tv>' + row('20260701100000') + row('20260701110000') + '</tv>'));
  assert.equal(guide.programmes.c[0].stop, '2026-07-01T11:00:00.000Z'); assert.equal(guide.programmes.c[1].endStatus, 'unknown');
});
