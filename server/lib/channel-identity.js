import { readCollection, updateCollection } from './store.js';
import { legacyChannelId, effectiveKind } from '../../shared/m3u.js';
import { channelAliases, channelRoute, channelIdentitySnapshot, reconcileChannelIdentities, remapReferences } from '../../shared/channel-identity.js';
const COLLECTION = 'channel-identities';
const scoped = (playlistId, channel) => ({
  ...channel,
  id: playlistId + '__' + channel.id,
  playlistId
});
export async function identityState() {
  const entries = (await readCollection(COLLECTION, {
    strict: true
  })) || [];
  const aliases = {},
    channels = [];
  const playlists = (await readCollection('playlists', {
    strict: true
  })) || [];
  for (const entry of entries) {
    for (const [old, id] of Object.entries(entry.aliases || {})) aliases[entry.playlistId + '__' + old] = entry.playlistId + '__' + id;
    const playlist = playlists.find(record => record.id === entry.playlistId);
    if (playlist && !playlist.deleted) channels.push(...entry.channels.map(channel => ({
      ...scoped(entry.playlistId, channel),
      kind: effectiveKind(playlist.contentKind, channel)
    })));
  }
  return {
    entries,
    aliases,
    channels
  };
}
export async function canonicalStateValue(key, value) {
  const state = await identityState();
  return remapReferences(value, key, state.aliases, state.channels);
}
async function migrateState() {
  const state = await identityState();
  const records = await readCollection('state');
  if (records.some(record => JSON.stringify(record.value) !== JSON.stringify(remapReferences(record.value, record.key, state.aliases, state.channels)))) await updateCollection('state', list => list.map(record => {
    const value = remapReferences(record.value, record.key, state.aliases, state.channels);
    return JSON.stringify(value) === JSON.stringify(record.value) ? record : {
      ...record,
      value,
      updatedAt: new Date(Math.max(Date.now(), (Date.parse(record.updatedAt) || 0) + 1)).toISOString()
    };
  }));
  // Active captures own their input snapshot. Only future jobs are migrated.
  const jobs = await readCollection('recordings');
  const fresh = new Map(state.channels.map(channel => [channel.id, channel]));
  const update = record => {
    if (record.status !== 'scheduled' || typeof record.channelId !== 'string' || !record.channelId.includes('__')) return record;
    let id = record.channelId;
    const seen = new Set();
    while (state.aliases[id] && !seen.has(id)) {
      seen.add(id);
      id = state.aliases[id];
    }
    const channel = fresh.get(id);
    if (!channel) return {
      ...record,
      channelIdentityIssue: 'unavailable-or-ambiguous'
    };
    return {
      ...record,
      channelId: id,
      channelName: channel.name,
      channelLogo: channel.logo || '',
      channelTvgId: channel.tvgId || '',
      channelNumber: channel.chno ?? null,
      url: channel.url,
      httpUserAgent: channel.httpUserAgent || '',
      httpReferrer: channel.httpReferrer || '',
      channelIdentityIssue: ''
    };
  };
  if (jobs.some(record => JSON.stringify(record) !== JSON.stringify(update(record)))) await updateCollection('recordings', list => list.map(update));
}
function boundedAliases(aliases, backup = {}) {
  const retained = {
      ...backup
    },
    counts = new Map();
  let size = Object.keys(retained).length;
  for (const [old, target] of Object.entries(aliases).reverse()) {
    const count = counts.get(target) || 0;
    if (count < 64 && size < 200000 || Object.hasOwn(backup, old)) {
      if (!Object.hasOwn(retained, old)) size++;
      retained[old] = target;
      counts.set(target, count + 1);
    }
  }
  return retained;
}
async function withUnresolved(playlistId, result) {
  const records = await readCollection('state'),
    references = [];
  for (const record of records) {
    if (record.key === 'favourites' && Array.isArray(record.value)) references.push(...record.value);
    if (record.key === 'settings') references.push(...Object.keys(record.value?.epgOverrides || {}));
  }
  for (const row of await readCollection('recordings')) if (row.status === 'scheduled') references.push(row.channelId);
  const scopedReferences = references.filter(ref => typeof ref === 'string' && ref.startsWith(playlistId + '__'));
  const live = new Set(result.channels.map(channel => channel.id));
  const conflicts = [...result.conflicts];
  for (const ref of references) {
    if (typeof ref !== 'string' || !ref.startsWith(playlistId + '__')) continue;
    let id = ref.slice(playlistId.length + 2);
    const seen = new Set();
    while (result.aliases[id] && !seen.has(id)) {
      seen.add(id);
      id = result.aliases[id];
    }
    if (!live.has(id)) conflicts.push({
      id,
      reason: 'unresolved-reference'
    });
  }
  for (const row of records) {
    if (row.key !== 'settings') continue;
    const overrides = row.value?.epgOverrides || {};
    for (const ref of Object.keys(overrides)) {
      if (!ref.startsWith(playlistId + '__')) continue;
      const bare = ref.slice(playlistId.length + 2), target = result.aliases[bare];
      const mapped = target && playlistId + '__' + target;
      if (mapped && mapped !== ref && Object.hasOwn(overrides, mapped) && overrides[ref] !== overrides[mapped]) conflicts.push({id: bare, reason: 'override-conflict'});
    }
  }
  return {
    ...result,
    conflicts,
    references: [...new Set(scopedReferences.map(ref => ref.slice(playlistId.length + 2)))]
  };
}
export async function reconcilePlaylistChannels(playlistId, raw, previousSeed = []) {
  let result;
  const histories = (await readCollection('state')).find(row => row.key === 'history')?.value || [];
  const groups = new Map();
  for (const row of Array.isArray(histories) ? histories : []) {
    if (typeof row.id !== 'string' || !row.id.startsWith(playlistId + '__')) continue;
    const channel = {
      ...row,
      id: row.id.slice(playlistId.length + 2)
    };
    const key = (channel.tvgId || '') + '|' + channelRoute(channel);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(channel);
  }
  const historySeeds = [...groups.values()].map(rows => rows[0]);
  await updateCollection(COLLECTION, list => {
    const i = list.findIndex(entry => entry.playlistId === playlistId),
      previous = i < 0 ? null : list[i];
    result = reconcileChannelIdentities(previous?.knownChannels || previous?.channels || previousSeed, raw.slice(0, 100000));
    const aliases = {
      ...(previous?.aliases || {}),
      ...result.aliases
    };
    const recovered = channelAliases(historySeeds, result.channels);
    for (const rows of groups.values()) {
      const target = recovered[rows[0].id] || result.channels.find(channel => channel.id === rows[0].id)?.id;
      if (target) for (const row of rows) if (row.id !== target) aliases[row.id] = target;
    }
    const seen = new Map();
    for (const channel of result.channels) if (!channel.identityAmbiguous) aliases[legacyChannelId(channel, seen)] = channel.id;
    // Retain migration evidence without logging sources or rewriting raw files.
    const known = new Map((previous?.knownChannels || previous?.channels || previousSeed).map(channel => [channel.id, channel]));
    for (const channel of result.channels) {
      known.delete(channel.id);
      known.set(channel.id, channelIdentitySnapshot(channel));
    }
    const live = new Set(result.channels.map(channel => channel.id));
    for (const id of live) delete aliases[id];
    const entry = {
      playlistId,
      version: 3,
      knownChannels: [...known.values()].slice(-200000).map(channelIdentitySnapshot),
      channels: result.channels,
      aliases: boundedAliases(aliases, previous?.migrationBackup?.aliases),
      conflicts: result.conflicts,
      migrationBackup: previous?.migrationBackup || {
        version: 2,
        aliases: {
          ...aliases
        }
      }
    };
    if (i < 0) list.push(entry);else list[i] = entry;
    result = {
      ...result,
      aliases: entry.aliases
    };
    return list;
  }, {
    strict: true
  });
  await migrateState();
  return withUnresolved(playlistId, result);
}
export async function registerChannelAliases(playlistId, aliases) {
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.keys(aliases).length > 2000) throw Object.assign(new Error('Invalid channel migration'), {
    status: 400
  });
  let result;
  await updateCollection(COLLECTION, list => {
    const entry = list.find(row => row.playlistId === playlistId);
    if (!entry) throw Object.assign(new Error('Load current channels before migration'), {
      status: 409
    });
    const valid = new Set(entry.channels.filter(channel => !channel.identityAmbiguous).map(channel => channel.id));
    for (const [old, id] of Object.entries(aliases)) {
      if (typeof id !== 'string' || old.length > 256 || !valid.has(id)) continue;
      if (valid.has(old) && old !== id) {
        entry.conflicts.push({
          id: old,
          reason: 'alias-conflict'
        });
        continue;
      }
      if (entry.aliases[old] && entry.aliases[old] !== id) {
        entry.conflicts.push({
          id: old,
          reason: 'alias-conflict'
        });
        continue;
      }
      if (old !== id) {
        entry.aliases[old] = id;
        if (!old.startsWith('c3-')) entry.migrationBackup.aliases[old] = id;
      }
    }
    entry.aliases = boundedAliases(entry.aliases, entry.migrationBackup.aliases);
    result = {
      version: 3,
      channels: entry.channels,
      aliases: entry.aliases,
      conflicts: entry.conflicts
    };
    return list;
  }, {
    strict: true
  });
  await migrateState();
  return withUnresolved(playlistId, result);
}
export async function recordingIdentity(record, resolvePlaylist) {
  if (typeof record.channelId !== 'string' || !record.channelId.includes('__')) return record;
  const split = record.channelId.indexOf('__'),
    playlistId = record.channelId.slice(0, split),
    bare = record.channelId.slice(split + 2);
  const result = await resolvePlaylist(playlistId);
  let id = bare;
  const visited = new Set();
  while (result.aliases[id] && !visited.has(id)) {
    visited.add(id);
    id = result.aliases[id];
  }
  let channel = result.channels.find(channel => channel.id === id);
  if (!channel) {
    // Old scheduled rows may be the last remaining v2 snapshot. Use only the
    // same unique evidence as other migrations, never a name-only guess.
    const previous = {
      id: bare,
      name: record.channelName,
      url: record.url,
      tvgId: record.channelTvgId || '',
      chno: record.channelNumber ?? null
    };
    const alias = channelAliases([previous], result.channels);
    channel = result.channels.find(channel => channel.id === alias[bare]);
  }
  if (!channel) throw Object.assign(new Error('Scheduled channel is unavailable or ambiguous'), {
    code: 'CHANNEL_UNAVAILABLE'
  });
  return {
    ...record,
    channelId: playlistId + '__' + channel.id,
    channelName: channel.name,
    channelLogo: channel.logo || '',
    channelTvgId: channel.tvgId || '',
    channelNumber: channel.chno ?? null,
    url: channel.url,
    httpUserAgent: channel.httpUserAgent || '',
    httpReferrer: channel.httpReferrer || ''
  };
}
