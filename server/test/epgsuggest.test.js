// Public-guide registry (server/lib/epgsources.js) and coverage matching
// (server/lib/epgmatch.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { EPG_SOURCE_REGISTRY, suggestionsForCountries } from '../lib/epgsources.js';
import { normalizeName, matchGuideToChannels, matchAll, buildAltNameIndex, channelIdCandidates } from '../lib/epgmatch.js';

const GUIDE = {
  channels: { 'Digi24.ro': { name: 'Digi 24' }, 'PROTV.ro': { name: 'Pro TV International' } },
  programmes: { 'Digi24.ro': [{ title: 'News' }], 'PROTV.ro': [{ title: 'Film' }] },
};

test('matchAll reports which tier resolved each channel', () => {
  const altNames = { protv: 'PROTV.ro' };
  const results = matchAll(
    [
      { id: 'p__a', tvgId: 'Digi24.ro', name: 'Digi 24 HD', country: 'ro', playlistId: 'p' },
      { id: 'p__b', tvgId: '', name: 'Digi 24', country: 'ro', playlistId: 'p' },
      { id: 'p__c', tvgId: '', name: 'PRO TV', country: 'ro', playlistId: 'p' },
      { id: 'p__d', tvgId: '', name: 'Nowhere TV', country: 'ro', playlistId: 'p' },
      { id: 'p__e', tvgId: '', name: 'Anything', country: 'ro', playlistId: 'p' },
    ],
    GUIDE,
    { p__e: 'Digi24.ro' },
    altNames
  );

  assert.deepEqual(
    results.map((result) => result.method),
    ['tvgId', 'name', 'altName', null, 'override']
  );
  assert.equal(results.find((r) => r.channelId === 'p__c').matchedKey, 'PROTV.ro');
  assert.equal(results.find((r) => r.channelId === 'p__d').matchedKey, null);
});

test('an override wins even when it points somewhere the auto tiers would not', () => {
  const [result] = matchAll(
    [{ id: 'p__a', tvgId: 'Digi24.ro', name: 'Digi 24', country: 'ro', playlistId: 'p' }],
    GUIDE,
    { p__a: 'PROTV.ro' }
  );

  assert.equal(result.method, 'override');
  assert.equal(result.matchedKey, 'PROTV.ro');
});

test('the alt-name index only carries names the guide can actually resolve', () => {
  const dataset = {
    byCountryName: new Map([
      [
        'ro',
        new Map([
          ['protv', { id: 'PROTV.ro' }], // alt name, guide calls it "Pro TV International"
          ['protvinternational', { id: 'PROTV.ro' }], // already the guide's own name
          ['ghostchannel', { id: 'Ghost.ro' }], // not in the guide at all
        ]),
      ],
    ]),
  };

  const index = buildAltNameIndex(dataset, GUIDE);

  assert.deepEqual(index, { protv: 'PROTV.ro' });
});

test('buildAltNameIndex degrades to empty when the dataset is not cached', () => {
  assert.deepEqual(buildAltNameIndex(null, GUIDE), {});
});

test('every registry entry builds a valid https URL', () => {
  for (const source of EPG_SOURCE_REGISTRY) {
    const countryCode = source.countries === 'all' ? 'ro' : source.countries[0];
    const url = new URL(source.urlFor(countryCode));
    assert.equal(url.protocol, 'https:', `${source.id} must be https`);
    assert.ok(source.id && source.name && source.notes, `${source.id} is fully described`);
  }
});

test('suggestions are per-country and respect each provider coverage', () => {
  const suggestions = suggestionsForCountries(['ro', 'gb']);

  const romanian = suggestions.filter((s) => s.country === 'ro').map((s) => s.id);
  const british = suggestions.filter((s) => s.country === 'gb').map((s) => s.id);

  assert.deepEqual(romanian, ['epgshare01'], 'gb-only providers are not offered for ro');
  assert.deepEqual(british.sort(), ['epgshare01', 'freeview-epg']);
  assert.equal(
    suggestions.find((s) => s.country === 'ro' && s.id === 'epgshare01').url,
    'https://epgshare01.online/epgshare01/epg_ripper_RO1.xml.gz'
  );
});

// Regression: the app normalizes uk -> gb, but EPGSHARE01 publishes the pack as
// UK — epg_ripper_GB1.xml.gz is a 404, so every GB install got a dead suggestion.
test('a provider code alias is used in the URL while the country stays ISO', () => {
  const [suggestion] = suggestionsForCountries(['gb']).filter((s) => s.id === 'epgshare01');

  assert.equal(suggestion.url, 'https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz');
  assert.equal(suggestion.country, 'gb', 'the row is still labelled with the ISO code');
});

test('a country code that is not two letters is never interpolated into a URL', () => {
  assert.deepEqual(suggestionsForCountries(['', '../etc', 'ROU', 'r']), []);
});

test('normalizeName folds case, diacritics and quality suffixes', () => {
  assert.equal(normalizeName('Digi 24 HD'), 'digi24');
  assert.equal(normalizeName('digi-24'), 'digi24');
  assert.equal(normalizeName('Știri UHD'), 'stiri');
  assert.equal(normalizeName(null), '');
});

// Real playlists annotate names with resolution and status; the guide does not.
test('normalizeName drops parenthetical and bracketed annotations', () => {
  assert.equal(normalizeName('Agro TV (360p) [Not 24/7]'), 'agrotv');
  assert.equal(normalizeName('Aleph News (720p)'), 'alephnews');
  assert.equal(normalizeName('Pro TV'), normalizeName('Pro TV (1080p)'));
});

// iptv-org playlists carry a feed suffix that guides usually drop.
test('a tvg-id matches with and without its @FEED suffix', () => {
  assert.deepEqual(channelIdCandidates('Digi24.ro@SD'), ['Digi24.ro@SD', 'Digi24.ro']);
  assert.deepEqual(channelIdCandidates('Digi24.ro'), ['Digi24.ro']);
  assert.deepEqual(channelIdCandidates(''), []);

  const guide = { channels: { 'Digi24.ro': { name: 'Digi 24' } }, programmes: { 'Digi24.ro': [] } };
  const [result] = matchAll([{ id: 'p__a', tvgId: 'Digi24.ro@SD', name: 'Whatever', country: 'ro', playlistId: 'p' }], guide);
  assert.equal(result.method, 'tvgId');
  assert.equal(result.matchedKey, 'Digi24.ro');
});

// An exact hit must still win, so a guide that really keys on the feed is honoured.
test('an exact feed-suffixed id beats the stripped one', () => {
  const guide = {
    channels: { 'Digi24.ro@SD': { name: 'Digi 24 SD' }, 'Digi24.ro': { name: 'Digi 24' } },
    programmes: { 'Digi24.ro@SD': [], 'Digi24.ro': [] },
  };
  const [result] = matchAll([{ id: 'p__a', tvgId: 'Digi24.ro@SD', name: 'x', country: 'ro', playlistId: 'p' }], guide);
  assert.equal(result.matchedKey, 'Digi24.ro@SD');
});

test('matching counts tvg-id hits, name hits, and reports the misses', () => {
  const guide = {
    channels: { 'Digi24.ro': { name: 'Digi 24' }, 'other.ro': { name: 'Pro TV' } },
    programmes: { 'Digi24.ro': [{ title: 'News' }] },
  };
  const channels = [
    { tvgId: 'Digi24.ro', name: 'Digi 24 HD', tvgName: '' },
    { tvgId: '', name: 'PRO TV', tvgName: '' },
    { tvgId: 'Missing.ro', name: 'Nowhere TV', tvgName: '' },
  ];

  const { matched, total, unmatched } = matchGuideToChannels(guide, channels);

  assert.equal(matched, 2, 'one by tvg-id, one by normalized name');
  assert.equal(total, 3);
  assert.deepEqual(unmatched, ['Nowhere TV']);
});

test('matching an empty channel set reports zero of zero rather than throwing', () => {
  assert.deepEqual(matchGuideToChannels({ channels: {} }, []), { matched: 0, total: 0, unmatched: [] });
});
