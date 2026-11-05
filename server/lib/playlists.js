import { reconcilePlaylistChannels } from './channel-identity.js';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { LOCAL_RADIO_PLAYLIST_ID, LOCAL_RADIO_PLAYLIST_NAME, validateStation, stationsToM3U } from '../../shared/station.js';
import { isBlockedTarget } from './http.js';
import { parseM3U } from '../../shared/m3u.js';
import { readCollection, updateCollection, playlistFilePath, PLAYLIST_DIR, writeFileAtomic } from './store.js';

// Cover the raw-file change, metadata commit and possible rollback with one
// queue. Metadata edits, legacy file writes and deletions share this boundary.
let pending = Promise.resolve();
function serialized(task) {
  const result = pending.then(task, task);
  pending = result.catch(() => {});
  return result;
}
function badInput(message, status = 400) { return Object.assign(new Error(message), { status }); }
function revision(record) { return Number.isSafeInteger(record?.revision) && record.revision > 0 ? record.revision : 1; }
function contentRevision(record) { return Number.isSafeInteger(record?.contentRevision) && record.contentRevision > 0 ? record.contentRevision : 1; }
function checkRevision(previous, expected) {
  if (previous?.deleted) throw badInput('Playlist was deleted; reload the server list', 410);
  if (previous && expected !== revision(previous)) throw badInput('Playlist changed on another device; reload before editing', 409);
  if (!previous && expected != null && expected !== 0) throw badInput('Playlist no longer exists; reload the server list', 409);
}
async function hasFile(id) {
  const file = playlistFilePath(id);
  if (!file) return false;
  try { return (await fs.stat(file)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function metadata(body, id, file) {
  return { id, name: body.name || 'Untitled Playlist', url: body.url || '', type: body.type || 'url',
    channelCount: body.channelCount || 0, enabled: body.enabled !== false,
    contentKind: ['live', 'radio', 'auto'].includes(body.contentKind) ? body.contentKind : 'auto',
    hasFile: file, updatedAt: new Date().toISOString() };
}
export function listPlaylists() {
  return serialized(async () => Promise.all(((await readCollection('playlists', { strict: true })) || []).filter((record) => !record.deleted).map(async (record) => ({
    ...record, identityVersion: 3, revision: revision(record), contentRevision: contentRevision(record), hasFile: await hasFile(record.id),
  }))));
}
export function savePlaylist(body) {
  return serialized(async () => {
    const id = body.id || randomUUID();
    if (id === LOCAL_RADIO_PLAYLIST_ID) throw badInput('Manage this playlist under Local radio stations', 409);
    if (typeof id !== 'string' || !playlistFilePath(id)) throw badInput('Bad id');
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) throw badInput('An explicit playlist revision is required', 409);
    let record;
    const file = await hasFile(id);
    await updateCollection('playlists', (list) => {
      const i = list.findIndex((p) => p.id === id);
      const previous = i < 0 ? null : list[i];
      if (!previous?.deleted && body.operationId && previous?.lastMutationId === body.operationId) { record = previous; return list; }
      checkRevision(previous, body.revision);
      record = { ...previous, ...metadata({ ...previous, ...body }, id, file),
        revision: previous ? revision(previous) + 1 : 1,
        contentRevision: previous ? contentRevision(previous) + (body.refreshContent === true || (body.url !== undefined && body.url !== previous.url) ? 1 : 0) : 1,
        lastMutationId: body.operationId || randomUUID() };
      if (i < 0) list.push(record); else list[i] = record;
      return list;
    }, { strict: true });
    // File availability remains server-owned; compute before the metadata write
    // in the same queue rather than trusting a client-provided flag.
    return { ...record, hasFile: await hasFile(id) };
  });
}

export function commitPlaylistFile(id, text, options = {}) {
  if (id === LOCAL_RADIO_PLAYLIST_ID) return Promise.reject(badInput('Manage this playlist under Local radio stations', 409));
  return serialized(() => commitPlaylistFileUnlocked(id, text, options));
}
async function commitPlaylistFileUnlocked(id, text, options = {}) {
    const file = typeof id === 'string' && playlistFilePath(id);
    if (!file) throw badInput('Bad id');
    if (typeof text !== 'string' || !text || text.includes('\0')) throw badInput('Invalid playlist: expected M3U text');
    if (Buffer.byteLength(text) > 25 * 1024 * 1024) throw badInput('Playlist file too large', 413);
    const channels = parseM3U(text);
    const list = (await readCollection('playlists', { strict: true })) || [];
    const previous = list.find((p) => p.id === id);
    const hash = createHash('sha256').update(text).digest('hex');
    if (previous?.deleted) checkRevision(previous, options.revision);
    // Retrying a lost acknowledgement repeats the same operation, without
    // overwriting a newer metadata edit or incrementing the content version.
    const operation = options.operationId || id;
    if (previous?.lastUploadId === operation && previous.contentHash === hash) {
      return { ...previous, revision: revision(previous), contentRevision: contentRevision(previous), hasFile: await hasFile(id) };
    }
    checkRevision(previous, options.revision);
    const record = { ...(id === LOCAL_RADIO_PLAYLIST_ID ? { managed: 'radio-stations' } : {}), ...metadata({ ...previous, ...options, name: options.name || previous?.name || 'Uploaded Playlist',
      url: '', type: 'file', channelCount: channels.length }, id, true),
      revision: previous ? revision(previous) + 1 : 1,
      contentRevision: previous ? contentRevision(previous) + (previous.contentHash === hash ? 0 : 1) : 1,
      contentHash: hash, lastUploadId: operation };
    let original = null;
    try { original = await fs.readFile(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original !== null) await reconcilePlaylistChannels(id, parseM3U(original.toString('utf8')));
    await fs.mkdir(PLAYLIST_DIR, { recursive: true });
    await writeFileAtomic(file, text);
    try {
      await updateCollection('playlists', (records) => {
        const i = records.findIndex((p) => p.id === id);
        if (i < 0) records.push(record); else records[i] = { ...records[i], ...record };
        return records;
      }, { strict: true });
    } catch (error) {
      // Nothing has been acknowledged. Preserve the previous complete file on
      // metadata failure; a retry with the same id safely repeats the commit.
      if (original === null) await fs.unlink(file);
      else await writeFileAtomic(file, original);
      throw error;
    }
    await reconcilePlaylistChannels(id, channels);
    return record;
}

export function deletePlaylist(id, expectedRevision) {
  if (id === LOCAL_RADIO_PLAYLIST_ID) return Promise.reject(badInput('Remove individual stations under Local radio stations', 409));
  return serialized(async () => {
    if (typeof id !== 'string' || !playlistFilePath(id)) throw badInput('Bad id');
    await updateCollection('playlists', (list) => {
      const i = list.findIndex((p) => p.id === id);
      const previous = i < 0 ? null : list[i];
      if (previous?.deleted) return list; // idempotent delete retry
      checkRevision(previous, expectedRevision);
      const tombstone = { id, deleted: true, enabled: false, hasFile: false,
        revision: previous ? revision(previous) + 1 : 1, updatedAt: new Date().toISOString() };
      if (i < 0) list.push(tombstone); else list[i] = tombstone;
      return list;
    }, { strict: true });
    const file = playlistFilePath(id);
    if (file) await fs.unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  });
}

async function localStationsUnlocked() {
  const record = ((await readCollection('playlists', { strict: true })) || []).find(p => p.id === LOCAL_RADIO_PLAYLIST_ID);
  if (!record) return { revision: 0, stations: [] };
  if (record.deleted || record.managed !== 'radio-stations') throw badInput('Local station playlist ID is already in use; preserve it and contact the administrator', 409);
  const channels = parseM3U(await fs.readFile(playlistFilePath(LOCAL_RADIO_PLAYLIST_ID), 'utf8'));
  return { revision: revision(record), stations: channels.map(c => ({ id: c.tvgId, name: c.name, url: c.url, logo: c.logo, genre: c.group, country: c.country || '' })) };
}
export function listLocalStations() { return serialized(localStationsUnlocked); }
export function changeLocalStation(body, id, remove = false) {
  return serialized(async () => {
    const current = await localStationsUnlocked();
    if (!Number.isSafeInteger(body.revision) || body.revision !== current.revision) throw badInput('Local stations changed on another device. Reload the list before saving; your form is kept.', 409);
    if (id && !current.stations.some(s => s.id === id)) throw badInput('Station no longer exists', 404);
    let stations;
    if (remove) stations = current.stations.filter(s => s.id !== id);
    else {
      let station;
      try { station = validateStation(body); } catch (error) { throw badInput(error.message); }
      if (isBlockedTarget(station.url) || (station.logo && isBlockedTarget(station.logo))) throw badInput('Station URL is blocked by the configured network policy', 403);
      station.id = id || randomUUID();
      if (!id && current.stations.length >= 500) throw badInput('Local station limit reached', 413);
      stations = id ? current.stations.map(s => s.id === id ? station : s) : [...current.stations, station];
    }
    await commitPlaylistFileUnlocked(LOCAL_RADIO_PLAYLIST_ID, stationsToM3U(stations), { revision: current.revision, operationId: randomUUID(), name: LOCAL_RADIO_PLAYLIST_NAME, contentKind: 'radio' });
    return localStationsUnlocked();
  });
}

// Hold source metadata/file mutations while configuration mappings are checked.
export function withPlaylistConfiguration(task) { return serialized(task); }
