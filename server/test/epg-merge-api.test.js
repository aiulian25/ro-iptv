import test from 'node:test';
import assert from 'node:assert/strict';
import { epgFixture } from './helpers/epg-commit-fixture.js';
const stamp = ms => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
test('real merged endpoint deduplicates overlapping guides, enriches metadata and preserves conflicting airings', { timeout: 20000 }, async t => {
  const now = Date.now(), start = stamp(now - 1800000), stop = stamp(now + 1800000), end = stamp(now + 5400000);
  const programme = (title, from, to, extra = '') => `<programme channel="c" start="${from}" stop="${to}"><title>${title}</title>${extra}</programme>`;
  const f = await epgFixture({ prefix: 'ro-iptv-aud018-fixture-', logDir: process.env.AUD018_LOG_DIR, xml: url => `<tv><channel id="c"><display-name>Fixture</display-name></channel>${programme('One', start, stop, url.includes('b.xml') ? '<desc>Second source details</desc>' : '')}${programme('Two', stop, end)}${url.includes('b.xml') ? programme('Conflict', start, stop) : ''}</tv>` }); t.after(f.cleanup);
  await f.save({ epgUrls: [f.origin + '/a.xml', f.origin + '/b.xml'] });
  const response = await fetch(f.base + '/api/epg/merged'); assert.equal(response.status, 200);
  const merged = await response.json(); assert.equal(merged.sourceCount, 2); assert.equal(merged.programmes.c.length, 3);
  assert.deepEqual(merged.programmes.c.map(p => p.title), ['One', 'Conflict', 'Two']); assert.equal(merged.programmes.c[0].desc, 'Second source details');
  const repeated = await (await fetch(f.base + '/api/epg/merged')).json(); assert.equal(repeated.guideRevision, merged.guideRevision); assert.equal(repeated.programmes.c.length, 3);
  assert.equal(f.hits['/a.xml'], 1); assert.equal(f.hits['/b.xml'], 1);
});
