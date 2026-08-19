// Server-side index of the channels the user actually has.
//
// The combined channel set has always lived in the browser (localStorage, built
// by client/src/store/useStore.js _rebuildChannels); the server kept only the raw
// playlists. EPG work needs the set server-side — "which channels, in which
// countries, does this install have" — so this module rebuilds it from the same
// inputs the client uses: every ENABLED playlist, re-parsed, kind-routed by the
// playlist's contentKind, and country-tagged.
//
// Channel ids are namespaced `${playlistId}__${channelId}`, matching the client
// exactly, so they line up with the settings.epgOverrides keys written by the
// Link EPG picker.
//
// Staleness has ONE rule: an index is stale once the playlists collection has
// changed at or after the index's build began. That covers the memory cache, the
// persisted copy, a mutation landing mid-build, and a restart — without any
// separate invalidation flag to keep in sync.
import { promises as fs } from 'fs';

import { parseM3U, effectiveKind } from './m3u.js';
import { channelCountry } from './country.js';
import { readCollection, writeCollection, collectionChangedAt, playlistFilePath } from './store.js';
import { FETCH_HEADERS, isValidUrl, isBlockedTarget, guardedFetch } from './http.js';

const COLLECTION = 'epg-channels';
const PLAYLIST_COLLECTION = 'playlists';
// A complete index is rebuilt this long after it was built; playlist writes
// invalidate it sooner via the staleness rule above.
const WANTED_TTL_MS = 6 * 60 * 60 * 1000;
// An index missing a playlist (upstream down, unreadable upload) is retried much
// sooner, so a transient failure isn't frozen in for hours.
const PARTIAL_INDEX_TTL_MS = 5 * 60 * 1000;
// Collapse a burst of playlist writes (a multi-playlist save, an upload followed
// by its metadata POST) into a single rebuild.
const DIRTY_DEBOUNCE_MS = 5000;
// A background rebuild must never hang on one unresponsive upstream.
const PLAYLIST_FETCH_TIMEOUT_MS = 30_000;
// Bounds what a rebuild retains in memory and writes to disk. Far above any real
// playlist; a truncated index says so rather than silently dropping channels.
const MAX_INDEXED_CHANNELS = 100_000;
// A rebuild superseded by a concurrent playlist write retries, but not forever:
// the write already scheduled its own rebuild, which publishes the current state.
const MAX_REBUILD_ATTEMPTS = 3;

let cached = null;
let cachedAt = 0;
let building = null;
let dirtyTimer = null;

// Raw channels of one playlist: re-fetched for URL playlists, re-read from the
// stored upload for file playlists. Throws so the caller can skip just this one.
async function readPlaylistChannels(playlist) {
  if (playlist.url) {
    if (!isValidUrl(playlist.url)) throw new Error('invalid playlist url');
    if (isBlockedTarget(playlist.url)) throw new Error('refusing a private-network playlist url');
    const upstream = await guardedFetch(playlist.url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(PLAYLIST_FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    return parseM3U(await upstream.text());
  }

  if (!playlist.hasFile) return [];
  const filePath = playlistFilePath(playlist.id);
  if (!filePath) throw new Error('bad playlist id');
  return parseM3U(await fs.readFile(filePath, 'utf8'));
}

/**
 * Build the wanted-channels index from the enabled playlists. Pure: it neither
 * caches nor persists — callers publish the result (see buildAndPublish).
 * `updatedAt` marks when the build STARTED, which is what the staleness rule
 * compares against the playlists collection.
 * @returns {Promise<{updatedAt: string, countries: string[], channels: object[],
 *   incomplete: boolean, skippedPlaylists: string[], truncated: boolean}>}
 */
export async function buildWantedChannels() {
  const updatedAt = new Date().toISOString();
  const playlists = (await readCollection(PLAYLIST_COLLECTION)).filter((p) => p.enabled !== false);
  const channels = [];
  const skippedPlaylists = [];
  let truncated = false;

  for (const playlist of playlists) {
    if (channels.length >= MAX_INDEXED_CHANNELS) {
      truncated = true;
      break;
    }
    let parsed;
    try {
      parsed = await readPlaylistChannels(playlist);
    } catch (err) {
      skippedPlaylists.push(playlist.id);
      console.warn(`epg-channels: skipped playlist ${playlist.id}:`, String(err));
      continue;
    }
    for (const channel of parsed) {
      channels.push({
        id: `${playlist.id}__${channel.id}`,
        tvgId: channel.tvgId || '',
        name: channel.name,
        tvgName: channel.tvgName || '',
        kind: effectiveKind(playlist.contentKind, channel),
        country: channelCountry(channel),
        playlistId: playlist.id,
      });
    }
  }

  if (channels.length > MAX_INDEXED_CHANNELS) {
    channels.length = MAX_INDEXED_CHANNELS;
    truncated = true;
  }
  if (truncated) console.warn(`epg-channels: index truncated at ${MAX_INDEXED_CHANNELS} channels`);

  const countries = [...new Set(channels.map((c) => c.country).filter(Boolean))].sort();
  return {
    updatedAt,
    countries,
    channels,
    incomplete: skippedPlaylists.length > 0,
    skippedPlaylists,
    truncated,
  };
}

// An index outlives its build by this long. A partial one expires quickly so the
// playlist that failed gets retried instead of sitting missing for hours.
function indexTtl(index) {
  return index.incomplete ? PARTIAL_INDEX_TTL_MS : WANTED_TTL_MS;
}

// Usable = within its TTL and built after the last playlist change.
async function isUsable(index, builtAt) {
  if (!index || !(builtAt > 0)) return false;
  if (Date.now() - builtAt >= indexTtl(index)) return false;
  return (await collectionChangedAt(PLAYLIST_COLLECTION)) < builtAt;
}

// Rebuild until the result reflects the playlist state it was built from, then
// publish it to memory and disk. A build superseded by a concurrent write is not
// published — that write's own debounced rebuild publishes the current state.
async function buildAndPublish() {
  let index = null;
  for (let attempt = 0; attempt < MAX_REBUILD_ATTEMPTS; attempt += 1) {
    index = await buildWantedChannels();
    const builtAt = Date.parse(index.updatedAt);
    if ((await collectionChangedAt(PLAYLIST_COLLECTION)) >= builtAt) continue;
    await writeCollection(COLLECTION, [index]);
    cached = index;
    cachedAt = builtAt;
    return index;
  }
  return index;
}

// Concurrent callers share one in-flight build.
function refreshWantedChannels() {
  if (building) return building;
  building = buildAndPublish().finally(() => {
    building = null;
  });
  return building;
}

// The persisted index from a previous run, when it's still usable.
async function loadPersistedIndex() {
  const stored = (await readCollection(COLLECTION))[0];
  if (!stored || !Array.isArray(stored.channels)) return null;
  const builtAt = Date.parse(stored.updatedAt);
  if (!(await isUsable(stored, builtAt))) return null;
  cached = stored;
  cachedAt = builtAt;
  return stored;
}

/**
 * The wanted-channels index: memoized, disk-backed across restarts, rebuilt when
 * stale or when `refresh` is set.
 */
export async function getWantedChannels({ refresh = false } = {}) {
  if (refresh) return refreshWantedChannels();
  if (await isUsable(cached, cachedAt)) return cached;
  const persisted = await loadPersistedIndex();
  if (persisted) return persisted;
  return refreshWantedChannels();
}

// Called by the playlist write endpoints. The index is already stale by then (the
// staleness rule sees the newer playlists file); this just rebuilds it eagerly,
// debounced, so the next read is served from cache instead of paying for a build.
export function markWantedChannelsDirty() {
  clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => {
    refreshWantedChannels().catch((err) => console.warn('epg-channels: rebuild failed:', String(err)));
  }, DIRTY_DEBOUNCE_MS);
  dirtyTimer.unref?.();
}
