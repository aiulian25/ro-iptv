import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-iptv-identity-store-'));
process.env.DATA_DIR = root;
const {
  writeCollection,
  readCollection
} = await import('../lib/store.js');
const {
  reconcilePlaylistChannels,
  registerChannelAliases,
  canonicalStateValue,
  recordingIdentity
} = await import('../lib/channel-identity.js');
const {
  parseM3U,
  legacyChannelId
} = await import('../../shared/m3u.js');
const {
  channelAliases
} = await import('../../shared/channel-identity.js');
test.after(() => fs.rm(root, {
  recursive: true,
  force: true
}));
const m3u = (name, url, id = 'guide') => `#EXTM3U\n#EXTINF:-1 tvg-id="${id}",${name}\n${url}\n`;
test('registry migration updates shared state and scheduled references while active capture inputs remain unchanged', async () => {
  await writeCollection('playlists', [{
    id: 'p',
    enabled: true,
    contentKind: 'radio'
  }]);
  const old = parseM3U(m3u('Old', 'https://fixture.invalid/old?token=a'))[0];
  old.id = legacyChannelId(old, new Map());
  const ref = 'p__' + old.id;
  await writeCollection('state', [{
    key: 'favourites',
    value: [ref],
    updatedAt: new Date().toISOString()
  }, {
    key: 'settings',
    value: {
      epgOverrides: {
        [ref]: 'manual-guide'
      }
    },
    updatedAt: new Date().toISOString()
  }, {
    key: 'history',
    value: [{
      ...old,
      id: ref,
      playlistId: 'p',
      at: 77
    }],
    updatedAt: new Date().toISOString()
  }]);
  const pending = {
    id: 'scheduled',
    status: 'scheduled',
    channelId: ref,
    url: old.url,
    channelName: old.name
  };
  const active = {
    ...pending,
    id: 'active',
    status: 'recording'
  };
  await writeCollection('recordings', [pending, active]);
  const current = await reconcilePlaylistChannels('p', parseM3U(m3u('New', 'https://fixture.invalid/new?token=b')));
  const id = 'p__' + current.channels[0].id;
  const state = await readCollection('state');
  assert.deepEqual(state.find(row => row.key === 'favourites').value, [id]);
  assert.equal(state.find(row => row.key === 'settings').value.epgOverrides[id], 'manual-guide');
  const history = state.find(row => row.key === 'history').value[0];
  assert.equal(history.url, 'https://fixture.invalid/new?token=b');
  assert.equal(history.kind, 'radio');
  assert.equal(history.at, 77);
  const jobs = await readCollection('recordings');
  assert.equal(jobs[0].channelId, id);
  assert.equal(jobs[0].url, history.url);
  assert.deepEqual(jobs[1], active);
  assert.deepEqual(await canonicalStateValue('favourites', [ref]), [id]);
  const entries = await readCollection('channel-identities');
  assert.equal(entries[0].version, 3);
  assert.equal(entries[0].migrationBackup.version, 2);
});
test('client cache aliases are persisted and a fresh registry read uses the same canonical ids', async () => {
  await writeCollection('playlists', [{
    id: 'p',
    enabled: true
  }, {
    id: 'q',
    enabled: true
  }]);
  const old = parseM3U(m3u('Old', 'https://fixture.invalid/old?token=a', 'q-guide'))[0];
  old.id = legacyChannelId(old, new Map());
  const current = await reconcilePlaylistChannels('q', parseM3U(m3u('New', 'https://fixture.invalid/new?token=b', 'q-guide')));
  const aliases = channelAliases([old], current.channels);
  await registerChannelAliases('q', aliases);
  const next = await reconcilePlaylistChannels('q', parseM3U(m3u('Renamed', 'https://fixture.invalid/moved?token=c', 'q-guide')));
  assert.equal(next.channels[0].id, current.channels[0].id);
  assert.equal(next.aliases[old.id], next.channels[0].id);
  const record = await recordingIdentity({
    channelId: 'q__' + old.id,
    url: old.url,
    channelName: 'Old'
  }, async () => next);
  assert.equal(record.url, 'https://fixture.invalid/moved?token=c');
  assert.equal(record.channelId, 'q__' + next.channels[0].id);
  const standalone = {
    channelId: 'manual',
    url: 'https://fixture.invalid/snapshot'
  };
  assert.equal(await recordingIdentity(standalone, () => {
    throw new Error('must not fetch');
  }), standalone);
  await assert.rejects(recordingIdentity({
    channelId: 'q__unknown',
    url: 'https://fixture.invalid/unknown',
    channelName: 'Different'
  }, async () => next), {
    code: 'CHANNEL_UNAVAILABLE'
  });
});
test('known HD/SD identities survive variant removal and later return without swapping', async () => {
  await writeCollection('playlists', [{
    id: 'variants',
    enabled: true
  }]);
  const hd = m3u('News HD', 'https://fixture.invalid/hd', 'same'),
    sd = m3u('News SD', 'https://fixture.invalid/sd', 'same');
  const both = await reconcilePlaylistChannels('variants', parseM3U(hd + sd));
  const onlySd = await reconcilePlaylistChannels('variants', parseM3U(sd));
  assert.equal(onlySd.channels[0].id, both.channels[1].id);
  const onlyHd = await reconcilePlaylistChannels('variants', parseM3U(m3u('Renamed HD', 'https://fixture.invalid/hd-new', 'same')));
  assert.equal(onlyHd.channels[0].id, both.channels[0].id);
  assert.notEqual(onlyHd.channels[0].id, onlySd.channels[0].id);
});
test('conflicting manual-link targets are retained and reported instead of silently overwritten', async () => {
  await writeCollection('playlists', [{ id: 'conflict', enabled: true }]);
  const current = await reconcilePlaylistChannels('conflict', parseM3U(m3u('Channel', 'https://fixture.invalid/conflict', 'conflict')));
  const id = current.channels[0].id;
  await writeCollection('state', [{key:'settings',value:{epgOverrides:{'conflict__old-ref':null,['conflict__'+id]:'new-guide'}}}]);
  const result = await registerChannelAliases('conflict', {'old-ref':id});
  assert.ok(result.conflicts.some(row=>row.reason==='override-conflict'));
  const value = (await readCollection('state'))[0].value.epgOverrides;
  assert.equal(value['conflict__old-ref'], null);
  assert.equal(value['conflict__'+id], 'new-guide');
});
