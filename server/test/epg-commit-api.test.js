import test from 'node:test';
import assert from 'node:assert/strict';
import { epgFixture } from './helpers/epg-commit-fixture.js';
test('committed source revisions identify actual guide contents, reject stale loads and deduplicate cold reads', { timeout: 20000 }, async t => {
  const f = await epgFixture(); t.after(f.cleanup);
  const a = await f.save({ epgUrls: [f.origin + '/a.xml'] });
  assert.match(a.epgSourceRevision, /^[a-f0-9]{64}$/);
  const records = await (await fetch(f.base + '/api/state')).json();
  assert.equal(records.find(r => r.key === 'settings').epgSourceRevision, a.epgSourceRevision);
  const get = revision => fetch(f.base + '/api/epg/merged?sourceRevision=' + revision);
  const [one, two] = await Promise.all([get(a.epgSourceRevision), get(a.epgSourceRevision)]);
  const ga = await one.json(); assert.equal(two.status, 200); assert.ok(ga.channels.A);
  assert.equal(ga.sourceRevision, a.epgSourceRevision); assert.equal(ga.refreshState, 'ready');
  assert.match(ga.guideRevision, /^[a-f0-9]{64}$/); assert.equal(f.hits['/a.xml'], 1);
  const b = await f.save({ epgUrls: [f.origin + '/b.xml'] });
  assert.notEqual(b.epgSourceRevision, a.epgSourceRevision); assert.equal((await get(a.epgSourceRevision)).status, 409);
  const gb = await (await get(b.epgSourceRevision)).json(); assert.ok(gb.channels.B); assert.equal(gb.channels.A, undefined);
  assert.notEqual(gb.guideRevision, ga.guideRevision); assert.equal(gb.sourceRevision, b.epgSourceRevision);
  const coverage = await (await fetch(f.base + '/api/epg/coverage')).json(); assert.equal(coverage.sourceRevision, b.epgSourceRevision);
  const linked = await f.save({ epgUrls: [f.origin + '/b.xml'], epgOverrides: { 'p__fixture': 'B' } });
  assert.equal(linked.epgSourceRevision, b.epgSourceRevision);
  // A source change while a cold source is held must not label its old guide B.
  const slow = await f.save({ epgUrls: [f.origin + '/slow-a.xml'] }); f.holdNext();
  const pending = get(slow.epgSourceRevision);
  for (let n = 0; n < 200 && !f.hits['/slow-a.xml']; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.hits['/slow-a.xml'], 1);
  await f.save({ epgUrls: [f.origin + '/b.xml'] }); f.release();
  assert.equal((await pending).status, 409);
  // The delayed settings refresh reuses the just-fetched guides.
  await new Promise(r => setTimeout(r, 5200)); assert.equal(f.hits['/b.xml'], 1);
});
