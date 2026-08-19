// channels.xml generation for the iptv-org sidecar (server/lib/channelsxml.js)
// and the country-code convention in server/lib/iptvorg.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-sidecar-'));
process.env.DATA_DIR = DATA_DIR;

const { planChannelsXml, renderChannelsXml, generateChannelsXml, readSidecarSummary } = await import(
  '../lib/channelsxml.js'
);
const { iptvOrgCountryCode } = await import('../lib/iptvorg.js');

// Shaped exactly like loadIptvOrgIndex() returns.
function buildIndex(channels, guides) {
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const byCountryName = new Map();
  for (const channel of channels) {
    const countryCode = channel.country.toLowerCase();
    if (!byCountryName.has(countryCode)) byCountryName.set(countryCode, new Map());
    for (const name of [channel.name, ...(channel.alt_names || [])]) {
      byCountryName.get(countryCode).set(normalize(name), channel);
    }
  }
  return { byId, byCountryName, guidesByChannel: new Map(Object.entries(guides)) };
}

// Pre-seed the on-disk dataset cache so the index builds without any network.
async function seedDataset(name, records) {
  const dir = path.join(DATA_DIR, 'iptv-org');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.gz`), zlib.gzipSync(Buffer.from(JSON.stringify(records))));
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\b(hd|fhd|uhd|4k|8k|sd)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const INDEX = buildIndex(
  [
    { id: 'Digi24.ro', name: 'Digi 24', country: 'RO', alt_names: [] },
    { id: 'ProTV.ro', name: 'Pro TV', country: 'RO', alt_names: ['PROTV Romania'] },
    { id: 'Lonely.ro', name: 'Lonely Channel', country: 'RO', alt_names: [] },
  ],
  {
    'Digi24.ro': [
      { site: 'tv.blue.ch', siteId: '1650', lang: 'ro' },
      { site: 'programetv.ro', siteId: 'digi-24', lang: 'ro' },
    ],
    'ProTV.ro': [{ site: 'programetv.ro', siteId: 'pro-tv', lang: 'ro' }],
  }
);

test('iptv-org uses UK where the app uses the ISO gb', () => {
  assert.equal(iptvOrgCountryCode('gb'), 'UK');
  assert.equal(iptvOrgCountryCode('ro'), 'RO');
});

test('channels resolve by tvg-id and by normalized name within their country', () => {
  const plan = planChannelsXml(
    [
      { tvgId: 'Digi24.ro', name: 'Digi 24 HD', tvgName: '', country: 'ro' },
      { tvgId: '', name: 'PROTV Romania', tvgName: '', country: 'ro' },
    ],
    INDEX
  );

  assert.equal(plan.mapped, 2);
  assert.deepEqual(plan.entries.map((e) => e.xmltvId).sort(), ['Digi24.ro', 'ProTV.ro']);
});

test('the site covering the most of the user channels wins', () => {
  const plan = planChannelsXml(
    [
      { tvgId: 'Digi24.ro', name: 'Digi 24', tvgName: '', country: 'ro' },
      { tvgId: 'ProTV.ro', name: 'Pro TV', tvgName: '', country: 'ro' },
    ],
    INDEX
  );

  // Digi24 is on both sites; programetv.ro also carries ProTV, so it batches both.
  const digi = plan.entries.find((entry) => entry.xmltvId === 'Digi24.ro');
  assert.equal(digi.site, 'programetv.ro');
  assert.deepEqual(plan.sites, [{ site: 'programetv.ro', channels: 2 }]);
});

test('a channel with no guide entry is reported, not silently dropped', () => {
  const plan = planChannelsXml(
    [
      { tvgId: 'Digi24.ro', name: 'Digi 24', tvgName: '', country: 'ro' },
      { tvgId: 'Lonely.ro', name: 'Lonely Channel', tvgName: '', country: 'ro' },
      { tvgId: '', name: 'Not In Dataset', tvgName: '', country: 'ro' },
    ],
    INDEX
  );

  assert.equal(plan.mapped, 1);
  assert.deepEqual(plan.unmapped.sort(), ['Lonely Channel', 'Not In Dataset']);
});

test('HD and SD variants of one channel are emitted once but both count as covered', () => {
  const plan = planChannelsXml(
    [
      { tvgId: 'Digi24.ro', name: 'Digi 24 HD', tvgName: '', country: 'ro' },
      { tvgId: 'Digi24.ro', name: 'Digi 24 SD', tvgName: '', country: 'ro' },
      { tvgId: '', name: 'Not In Dataset', tvgName: '', country: 'ro' },
    ],
    INDEX
  );

  assert.equal(plan.entries.length, 1, 'the grabber only needs the channel once');
  assert.equal(plan.matchedChannels, 2, 'both variants are covered by that one entry');
  assert.equal(plan.matchedChannels + plan.unmapped.length, 3, 'every wanted channel is accounted for');
});

// Regression: the name index used to be keyed by iptv-org's own country code, so
// a lookup with the app's code could never hit for the one country where they
// disagree — every UK channel silently failed to map.
test('a UK channel resolves through the app gb code', async () => {
  const { loadIptvOrgIndex } = await import('../lib/iptvorg.js');
  await seedDataset('channels.json', [
    { id: 'BBCOne.uk', name: 'BBC One', country: 'UK', alt_names: [], closed: null, replaced_by: null },
  ]);
  await seedDataset('guides.json', [
    { channel: 'BBCOne.uk', feed: null, site: 'tv.blue.ch', site_id: '37', lang: 'en' },
  ]);

  const index = await loadIptvOrgIndex(['gb']);
  const plan = planChannelsXml([{ tvgId: '', name: 'BBC One', tvgName: '', country: 'gb' }], index);

  assert.equal(plan.mapped, 1);
  assert.equal(plan.entries[0].xmltvId, 'BBCOne.uk');
});

// Regression: a channel that shut down should not be handed to the grabber.
test('closed channels are excluded from the name index', async () => {
  const { loadIptvOrgIndex } = await import('../lib/iptvorg.js');
  await seedDataset('channels.json', [
    { id: 'Dead.ro', name: 'Dead Channel', country: 'RO', alt_names: [], closed: '2020-01-01', replaced_by: null },
  ]);
  await seedDataset('guides.json', [
    { channel: 'Dead.ro', feed: null, site: 'programetv.ro', site_id: 'dead', lang: 'ro' },
  ]);

  const index = await loadIptvOrgIndex(['ro']);
  const plan = planChannelsXml([{ tvgId: '', name: 'Dead Channel', tvgName: '', country: 'ro' }], index);

  assert.equal(plan.mapped, 0);
  assert.deepEqual(plan.unmapped, ['Dead Channel']);
});

test('rendered XML escapes every entity and is well formed', () => {
  const xml = renderChannelsXml([
    { site: 'a&b.com', lang: 'ro', xmltvId: 'X<Y.ro', siteId: 'q"uote', name: "Ben & Jerry's <Live>" },
  ]);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<channels>\n/);
  assert.match(xml, /site="a&amp;b\.com"/);
  assert.match(xml, /xmltv_id="X&lt;Y\.ro"/);
  assert.match(xml, /site_id="q&quot;uote"/);
  assert.match(xml, />Ben &amp; Jerry&apos;s &lt;Live&gt;<\/channel>/);
  assert.ok(!/[<>&](?![a-z]+;)/.test(xml.split('\n')[2].replace(/<\/?channel[^>]*>?/g, '')));
});

test('generate with no located channels writes nothing and records why', async () => {
  const summary = await generateChannelsXml({ countries: [], channels: [{ name: 'No Country', country: '' }] });

  assert.equal(summary.written, false);
  assert.equal(summary.mapped, 0);
  assert.deepEqual(await readSidecarSummary(), summary);
  assert.equal(
    await fs
      .access(path.join(DATA_DIR, 'epg', 'channels.xml'))
      .then(() => true)
      .catch(() => false),
    false
  );
});
