import test from 'node:test';
import assert from 'node:assert/strict';
import { epgFixture } from './helpers/epg-commit-fixture.js';
const HOUR = 3600000;
const stamp = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
export function coverageSource(mode) {
  const id = mode === 'a' ? 'old' : 'new';
  const start = Date.now() + (mode === 'boundary' ? 48 * HOUR + 2000 : mode === 'expired' ? -200 * HOUR : -HOUR);
  const stop = start + HOUR;
  return `<tv><channel id="${id}"><display-name>Guide ${id}</display-name></channel>${mode === 'metadata' ? '' : `<programme channel="${id}" start="${stamp(start)}" stop="${stamp(stop)}"><title>Fixture show</title></programme>`}</tv>`;
}
test('coverage revisions replace equal-count data, retain broken manual targets and distinguish schedules in window', { timeout: 20000 }, async t => {
  let mode = 'a'; const f = await epgFixture({ xml: () => coverageSource(mode), control: true, prefix: 'ro-iptv-aud016-fixture-', logDir: process.env.AUD016_LOG_DIR }); t.after(f.cleanup);
  const source = f.origin + '/same.xml';
  const response = await fetch(f.base + '/api/playlists/p/file?revision=0&operationId=coverage', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: '#EXTM3U\n#EXTINF:-1 tvg-id="old",Fixture\nhttps://stream.example/live\n' }); assert.equal(response.status, 200);
  const channels = await (await fetch(f.base + '/api/playlists/p/channels')).json();
  const id = 'p__' + channels.channels[0].id;
  await f.save({ epgUrls: [source], epgOverrides: { [id]: 'old' } });
  const coverage = async () => { const r = await fetch(f.base + '/api/epg/coverage'); assert.equal(r.status, 200); return r.json(); };
  const first = await coverage(); assert.equal(first.byPlaylist[0].matched, 1); assert.equal(first.byPlaylist[0].scheduled, 1);
  assert.equal((await coverage()).generatedAt, first.generatedAt, 'Unchanged coverage uses the cache');
  mode = 'b'; await f.control('refresh', source);
  const second = await coverage(); assert.notEqual(second.guideRevision, first.guideRevision);
  assert.equal(second.sourceRevision, first.sourceRevision); assert.equal(second.byPlaylist[0].matched, 0); assert.equal(second.byPlaylist[0].scheduled, 0);
  assert.equal(second.links[0].status, 'missing-target'); assert.equal(second.links[0].targetKey, 'old');
  assert.equal(second.byPlaylist[0].unmatched[0].status, 'missing-target');
  const record = (await (await fetch(f.base + '/api/state')).json()).find(r => r.key === 'settings'); assert.equal(record.value.epgOverrides[id], 'old');
  await f.save({ epgUrls: [source], epgOverrides: { [id]: 'new' } });
  assert.equal((await coverage()).byPlaylist[0].scheduled, 1);
  mode = 'metadata'; await f.control('refresh', source);
  const metadata = await coverage(); assert.equal(metadata.byPlaylist[0].matched, 1); assert.equal(metadata.byPlaylist[0].scheduled, 0); assert.equal(metadata.links[0].status, 'metadata-only');
  mode = 'expired'; await f.control('refresh', source);
  assert.equal((await coverage()).byPlaylist[0].scheduled, 0, 'Out-of-window programmes are not schedule coverage');
  const merged = await (await fetch(f.base + '/api/epg/merged')).json(); assert.equal(Object.keys(merged.programmes).length, 0);
  mode = 'boundary'; await f.control('refresh', source);
  const before = await coverage(); assert.equal(before.byPlaylist[0].scheduled, 0);
  await f.control('clock', 4000);
  const after = await coverage(); assert.equal(after.guideRevision, before.guideRevision); assert.equal(after.byPlaylist[0].scheduled, 1, 'Rolling-window boundary expires coverage without a guide refresh');
});
