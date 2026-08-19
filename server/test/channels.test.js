// Wanted-channels index (server/lib/channels.js).
// DATA_DIR must be set before importing the store, which reads it at load time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-channels-'));
process.env.DATA_DIR = DATA_DIR;

const ENABLED_ID = 'enabled-playlist';
const DISABLED_ID = 'disabled-playlist';
const TRAVERSAL_ID = '../escaped';

const PLAYLIST_M3U = `#EXTM3U
#EXTINF:-1 tvg-id="Digi24.ro" tvg-name="Digi 24" tvg-logo="http://logo/d.png" group-title="RO | News",Digi 24 HD
http://example.com/digi24.m3u8
#EXTINF:-1 tvg-id="EuropaFM.ro" group-title="Muzica",Europa FM
http://example.com/europafm.mp3
#EXTINF:-1 group-title="GB | Documentary",Some UK Channel
http://example.com/uk.m3u8
`;

const ESCAPED_M3U = `#EXTM3U
#EXTINF:-1 group-title="Secret",Should Never Appear
http://example.com/secret.m3u8
`;

async function writePlaylists(records) {
  await fs.writeFile(path.join(DATA_DIR, 'playlists.json'), JSON.stringify(records, null, 2), 'utf8');
}

await fs.mkdir(path.join(DATA_DIR, 'playlists'), { recursive: true });
await fs.writeFile(path.join(DATA_DIR, 'playlists', `${ENABLED_ID}.m3u`), PLAYLIST_M3U, 'utf8');
await fs.writeFile(path.join(DATA_DIR, 'playlists', `${DISABLED_ID}.m3u`), PLAYLIST_M3U, 'utf8');
// The file a traversal id would reach: DATA_DIR/playlists/../escaped.m3u
await fs.writeFile(path.join(DATA_DIR, 'escaped.m3u'), ESCAPED_M3U, 'utf8');

const { buildWantedChannels, getWantedChannels, markWantedChannelsDirty } = await import('../lib/channels.js');

test('indexes enabled playlists only, with namespaced ids, kinds and countries', async () => {
  await writePlaylists([
    { id: ENABLED_ID, name: 'Enabled', url: '', hasFile: true, enabled: true, contentKind: 'auto' },
    { id: DISABLED_ID, name: 'Disabled', url: '', hasFile: true, enabled: false, contentKind: 'auto' },
  ]);

  const index = await buildWantedChannels();

  assert.equal(index.channels.length, 3, 'the disabled playlist is excluded');
  assert.ok(index.channels.every((c) => c.id.startsWith(`${ENABLED_ID}__`)), 'ids are playlist-namespaced');
  assert.deepEqual(index.countries, ['gb', 'ro']);

  const digi = index.channels.find((c) => c.tvgId === 'Digi24.ro');
  assert.equal(digi.country, 'ro', 'tvg-id suffix wins');
  assert.equal(digi.kind, 'live');
  assert.equal(digi.name, 'Digi 24 HD');
  assert.equal(digi.playlistId, ENABLED_ID);

  assert.equal(index.channels.find((c) => c.tvgId === 'EuropaFM.ro').kind, 'radio');
  assert.equal(index.channels.find((c) => c.name === 'Some UK Channel').country, 'gb', 'group-title prefix');
  assert.ok(Date.parse(index.updatedAt) > 0);
});

test("a playlist's contentKind overrides per-channel detection", async () => {
  await writePlaylists([
    { id: ENABLED_ID, name: 'Enabled', url: '', hasFile: true, enabled: true, contentKind: 'radio' },
  ]);

  const index = await buildWantedChannels();

  assert.ok(index.channels.every((c) => c.kind === 'radio'));
});

test('a traversal playlist id reads nothing outside the playlists directory', async () => {
  await writePlaylists([{ id: TRAVERSAL_ID, name: 'Evil', url: '', hasFile: true, enabled: true }]);

  const index = await buildWantedChannels();

  assert.equal(index.channels.length, 0);
});

test('a playlist that cannot be read is reported rather than silently dropped', async () => {
  await writePlaylists([
    { id: ENABLED_ID, name: 'Enabled', url: '', hasFile: true, enabled: true, contentKind: 'auto' },
    { id: 'broken', name: 'Broken', url: 'not-a-url', enabled: true },
  ]);

  const index = await buildWantedChannels();

  assert.equal(index.incomplete, true);
  assert.deepEqual(index.skippedPlaylists, ['broken']);
  assert.equal(index.channels.length, 3, 'the readable playlist is still indexed');
});

test('getWantedChannels persists the index and serves it from cache', async () => {
  await writePlaylists([
    { id: ENABLED_ID, name: 'Enabled', url: '', hasFile: true, enabled: true, contentKind: 'auto' },
  ]);

  const first = await getWantedChannels({ refresh: true });
  const persisted = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'epg-channels.json'), 'utf8'));

  assert.equal(persisted[0].channels.length, first.channels.length);
  assert.equal(first.incomplete, false);
  assert.equal(await getWantedChannels(), first, 'a second read is served from memory');
});

// Regression: markWantedChannelsDirty used to clear only the in-memory stamp, so
// a read arriving before the debounced rebuild resurrected the pre-change index
// from disk and re-pinned it as fresh. Staleness now keys off the playlists file.
test('a playlist change invalidates both cache tiers before the debounced rebuild', async () => {
  await writePlaylists([
    { id: ENABLED_ID, name: 'Enabled', url: '', hasFile: true, enabled: true, contentKind: 'auto' },
  ]);
  assert.equal((await getWantedChannels({ refresh: true })).channels.length, 3);

  await writePlaylists([
    { id: ENABLED_ID, name: 'Enabled', url: '', hasFile: true, enabled: false, contentKind: 'auto' },
  ]);
  markWantedChannelsDirty();

  const afterChange = await getWantedChannels();
  assert.equal(afterChange.channels.length, 0, 'read in the debounce window rebuilds');
  assert.deepEqual(afterChange.countries, []);
});
