import test from 'node:test';
import assert from 'node:assert/strict';
const {
  parseM3U,
  legacyChannelId
} = await import(process.env.AUD013_M3U_MODULE || new URL('../../shared/m3u.js', import.meta.url).href);
const {
  channelAliases,
  reconcileChannelIdentities,
  remapReferences
} = await import('../../shared/channel-identity.js');
const source = (id, name, url, attrs = '') => `#EXTM3U\n#EXTINF:-1 ${id ? 'tvg-id="' + id + '"' : ''} ${attrs},${name}\n${url}\n`;
test('a unique guide id survives token, path, display-name and ordering changes', () => {
  const a = parseM3U(source('news.ro', 'Old News', 'https://fixture.invalid/old?token=a'))[0];
  const b = parseM3U(source('news.ro', 'New News', 'https://fixture.invalid/moved?token=b'))[0];
  assert.equal(a.id, b.id);
  assert.deepEqual(parseM3U(source('a', 'A', 'https://fixture.invalid/a') + source('b', 'B', 'https://fixture.invalid/b')).map(c => c.id).sort(), parseM3U(source('b', 'B', 'https://fixture.invalid/b') + source('a', 'A', 'https://fixture.invalid/a')).map(c => c.id).sort());
});
test('duplicate HD/SD variants remain distinct and stable when renamed, reordered or token-rotated', () => {
  const a = parseM3U(source('same', 'News HD', 'https://fixture.invalid/hd?token=a') + source('same', 'News SD', 'https://fixture.invalid/sd?token=a'));
  const b = parseM3U(source('same', 'Renamed SD', 'https://fixture.invalid/sd-new?token=b') + source('same', 'Renamed HD', 'https://fixture.invalid/hd-new?token=b'));
  assert.notEqual(a[0].id, a[1].id);
  assert.equal(a[0].id, b[1].id);
  assert.equal(a[1].id, b[0].id);
});
test('missing-guide identity retains routing parameters and tolerates token rotation or rename', () => {
  const a = parseM3U(source('', 'Old', 'https://fixture.invalid/live?id=1&token=a'))[0];
  const b = parseM3U(source('', 'New', 'https://fixture.invalid/live?token=b&id=1'))[0];
  const c = parseM3U(source('', 'New', 'https://fixture.invalid/live?id=2&token=b'))[0];
  assert.equal(a.id, b.id);
  assert.notEqual(b.id, c.id);
});
test('stored reconciliation preserves a missing-guide id across URL moves using unique number plus name', () => {
  const a = parseM3U(source('', 'News', 'https://fixture.invalid/old', 'tvg-chno="7"'));
  const b = parseM3U(source('', 'News', 'https://fixture.invalid/new', 'tvg-chno="7"'));
  const result = reconcileChannelIdentities(a, b);
  assert.equal(result.channels[0].id, a[0].id);
  assert.equal(result.aliases[b[0].id], a[0].id);
});
test('name-only or indistinguishable duplicate matches are surfaced, never merged automatically', () => {
  const a = parseM3U(source('', 'Same name', 'https://fixture.invalid/one'));
  const b = parseM3U(source('', 'Same name', 'https://fixture.invalid/two'));
  const result = reconcileChannelIdentities(a, b);
  assert.notEqual(result.channels[0].id, a[0].id);
  assert.deepEqual(result.aliases, {});
  assert.equal(result.conflicts.length, 1);
  const ambiguous = parseM3U(source('dup', 'Same', 'https://fixture.invalid/live?token=a') + source('dup', 'Same', 'https://fixture.invalid/live?token=b'));
  assert.equal(new Set(ambiguous.map(c => c.id)).size, 2);
  assert.ok(ambiguous.every(c => c.identityAmbiguous));
  assert.deepEqual(channelAliases(ambiguous, ambiguous), {});
});
test('v2 aliases migrate favourites, fresh history and manual links without overwriting conflicting targets', () => {
  const old = parseM3U(source('unique', 'Old', 'https://fixture.invalid/old?token=a'))[0];
  old.id = legacyChannelId(old, new Map());
  const fresh = parseM3U(source('unique', 'Renamed', 'https://fixture.invalid/new?token=b'))[0];
  const bare = channelAliases([old], [fresh]);
  const aliases = Object.fromEntries(Object.entries(bare).map(([a, b]) => ['p__' + a, 'p__' + b]));
  const current = {
    ...fresh,
    id: 'p__' + fresh.id,
    playlistId: 'p'
  };
  assert.deepEqual(remapReferences(['p__' + old.id], 'favourites', aliases, [current]), [current.id]);
  const history = remapReferences([{
    ...old,
    id: 'p__' + old.id,
    at: 123
  }], 'history', aliases, [current]);
  assert.equal(history[0].url, fresh.url);
  assert.equal(history[0].at, 123);
  assert.deepEqual(remapReferences({
    epgOverrides: {
      ['p__' + old.id]: 'guide'
    }
  }, 'settings', aliases, [current]).epgOverrides, {
    [current.id]: 'guide'
  });
  const conflict = remapReferences({
    epgOverrides: {
      ['p__' + old.id]: 'old',
      [current.id]: 'new'
    }
  }, 'settings', aliases, [current]);
  assert.equal(conflict.epgOverrides[current.id], 'new');
  assert.equal(conflict.epgOverrides['p__' + old.id], 'old');
});
test('stored duplicate variants survive loss of quality labels when unique guide numbers remain', () => {
  const old = parseM3U(source('same', 'Channel HD', 'https://fixture.invalid/hd', 'tvg-chno="7"') + source('same', 'Channel SD', 'https://fixture.invalid/sd', 'tvg-chno="8"'));
  const fresh = parseM3U(source('same', 'Renamed One', 'https://fixture.invalid/sd', 'tvg-chno="7"') + source('same', 'Renamed Two', 'https://fixture.invalid/hd', 'tvg-chno="8"'));
  const result = reconcileChannelIdentities(old, fresh);
  assert.equal(result.channels[0].id, old[0].id);
  assert.equal(result.channels[1].id, old[1].id);
});
