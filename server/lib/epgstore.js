// Server-side EPG engine.
//
// The guide used to be pulled per browser session: every client fetched each
// configured XMLTV source through /api/epg, merged them locally, and the server
// kept only an 8-slot 15-minute memory cache shared with playlist texts. Nothing
// refreshed while no tab was open, and a restart lost everything.
//
// Here the server owns the guide instead: each configured source is fetched,
// parsed once, and persisted gzipped under DATA_DIR/epg, so a merged guide is
// available immediately at first paint and survives restarts. Sources are
// refreshed on a schedule and whenever the user edits the source list.
import { promises as fs } from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';

import { parseEPG } from './epg.js';
import { readCollection, writeCollection, writeFileAtomic, TMP_SUFFIX, DATA_DIR } from './store.js';
import { FETCH_HEADERS, isValidUrl, isBlockedTarget, fetchToBuffer } from './http.js';

const HEALTH_COLLECTION = 'epg-health';
const STATE_COLLECTION = 'state';
const SETTINGS_KEY = 'settings';
const GUIDE_DIR = path.join(DATA_DIR, 'epg');
const GUIDE_FILE_PREFIX = 'guide-';
const GUIDE_FILE_SUFFIX = '.json.gz';

export const EPG_MAX_DOWNLOAD = 200 * 1024 * 1024; // 200 MB compressed
export const EPG_MAX_DECOMPRESSED = 600 * 1024 * 1024; // 600 MB after gunzip
// A guide can be large on a slow link, but a fetch must never hang forever.
const EPG_FETCH_TIMEOUT_MS = 180_000;
// A fetch on the request path gets a much tighter budget: a slow source must not
// hold up a page load. The background refresh still gets the full budget, so a
// large guide that misses this window is served from the store on the next read.
const EPG_REQUEST_FETCH_TIMEOUT_MS = 20_000;
// How long a source that failed to load is left alone by request-path reads.
// Scheduled refreshes ignore this and always retry.
const FAILED_SOURCE_RETRY_MS = 5 * 60 * 1000;
// Parsed guides held in memory. Small on purpose: each one can be hundreds of MB.
const MAX_CACHED_GUIDES = 4;
// Filename half-length of the sha256 of a source URL — a hex name derived from
// untrusted input can never escape GUIDE_DIR, and collisions are not a concern.
const URL_DIGEST_LENGTH = 16;
// A leftover temp file older than this is from a write that never completed;
// anything newer may still be in flight.
const STALE_TMP_MS = 60 * 60 * 1000;

const guideCache = new Map(); // url -> {fetchedAt, guide}; insertion order = LRU
const inFlight = new Map(); // url -> Promise, so concurrent cold reads fetch once
const failedSources = new Map(); // url -> ms of last failure; throttles retries
let mergedCache = null; // {signature, guide}
let refreshingAll = null;
let refreshQueued = false;

function guideFilePath(url) {
  const digest = crypto.createHash('sha256').update(url).digest('hex').slice(0, URL_DIGEST_LENGTH);
  return path.join(GUIDE_DIR, `${GUIDE_FILE_PREFIX}${digest}${GUIDE_FILE_SUFFIX}`);
}

function cacheGuide(url, entry) {
  guideCache.delete(url);
  guideCache.set(url, entry);
  while (guideCache.size > MAX_CACHED_GUIDES) {
    guideCache.delete(guideCache.keys().next().value);
  }
}

function readCachedGuide(url) {
  const entry = guideCache.get(url);
  if (!entry) return null;
  cacheGuide(url, entry); // refresh recency
  return entry;
}

/**
 * The EPG sources this install is configured with: the synced settings blob plus
 * the server's own EPG_URL. Mirrors epgSources() in client/src/store/useStore.js,
 * including the legacy single `epgUrl` field.
 */
export async function configuredEpgUrls() {
  const state = await readCollection(STATE_COLLECTION);
  const settings = state.find((entry) => entry.key === SETTINGS_KEY)?.value || {};
  const configured = Array.isArray(settings.epgUrls) ? settings.epgUrls : [];
  // EPG_SIDECAR_URL is the optional iptv-org grabber running alongside this app;
  // it is a source like any other, so it merges, reports health and refreshes
  // with the rest rather than needing its own path.
  const urls = [...configured, settings.epgUrl, process.env.EPG_URL, process.env.EPG_SIDECAR_URL]
    .map((url) => (url || '').trim())
    .filter(Boolean);
  return [...new Set(urls)];
}

// Download a guide and return its XML. Enforces the same target rules as the
// request-path endpoints, and caps the transfer WHILE reading rather than after,
// so an oversized or endless response can't exhaust memory before the check.
async function fetchGuideXml(url, timeoutMs) {
  if (!isValidUrl(url)) throw new Error('invalid EPG url');
  if (isBlockedTarget(url)) throw new Error('refusing a private-network EPG url');

  const buf = await fetchToBuffer(url, {
    headers: FETCH_HEADERS,
    timeoutMs,
    maxBytes: EPG_MAX_DOWNLOAD,
  });
  // gzip magic bytes (1f 8b) → a .xml.gz guide; otherwise treat as plain XML.
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf, { maxOutputLength: EPG_MAX_DECOMPRESSED }).toString('utf8');
  }
  return buf.toString('utf8');
}

/** Download + parse one source without persisting it. */
export async function fetchAndParseGuide(url, { timeoutMs = EPG_FETCH_TIMEOUT_MS } = {}) {
  return parseEPG(await fetchGuideXml(url, timeoutMs));
}

// Persist a parsed guide next to the URL it came from, so a load can prove the
// file belongs to the URL it was asked for. Atomic tmp+rename, as store.js does.
async function persistGuide(url, guide, fetchedAt) {
  await fs.mkdir(GUIDE_DIR, { recursive: true });
  await writeFileAtomic(guideFilePath(url), zlib.gzipSync(JSON.stringify({ url, fetchedAt, guide })));
}

/** Fetch a source, parse it, persist it, and cache it. Returns {fetchedAt, guide}. */
export async function refreshSource(url, options = {}) {
  try {
    const guide = await fetchAndParseGuide(url, options);
    const fetchedAt = new Date().toISOString();
    await persistGuide(url, guide, fetchedAt);
    const entry = { fetchedAt, guide };
    cacheGuide(url, entry);
    failedSources.delete(url);
    mergedCache = null;
    return entry;
  } catch (err) {
    // Covers the persist step too: an unwritable volume must throttle retries the
    // same way a dead upstream does, or every read re-downloads the whole guide.
    failedSources.set(url, Date.now());
    throw err;
  }
}

/** The persisted guide for a source, or null when it has never been fetched. */
export async function loadSource(url) {
  const cached = readCachedGuide(url);
  if (cached) return cached;
  let stored;
  try {
    stored = JSON.parse(zlib.gunzipSync(await fs.readFile(guideFilePath(url))).toString('utf8'));
  } catch {
    return null; // never fetched, unreadable, or corrupt — the caller refetches
  }
  // The filename is a digest; the record names the URL it was built from.
  if (!stored || stored.url !== url || !stored.guide) return null;
  const entry = { fetchedAt: stored.fetchedAt, guide: stored.guide };
  cacheGuide(url, entry);
  return entry;
}

// The persisted guide, fetching it only when nothing is stored yet. Concurrent
// callers for the same URL share one fetch, and a source that just failed is not
// retried on every page load — the scheduled refresh owns retrying it.
async function loadOrFetchSource(url) {
  const stored = await loadSource(url);
  if (stored) return stored;
  const pending = inFlight.get(url);
  if (pending) return pending;
  if (Date.now() - (failedSources.get(url) || 0) < FAILED_SOURCE_RETRY_MS) {
    throw new Error('source unavailable at last attempt');
  }
  const fetching = refreshSource(url, { timeoutMs: EPG_REQUEST_FETCH_TIMEOUT_MS }).finally(() =>
    inFlight.delete(url)
  );
  inFlight.set(url, fetching);
  return fetching;
}

/**
 * Merge several parsed guides into one {channels, programmes}.
 * Ported from mergeEpg in client/src/store/useStore.js so server-side merging is
 * indistinguishable from what the client used to do.
 */
export function mergeGuides(guides) {
  const channels = {};
  const programmes = {};
  for (const guide of guides) {
    Object.assign(channels, guide.channels || {});
    for (const [id, list] of Object.entries(guide.programmes || {})) {
      programmes[id] = (programmes[id] || []).concat(list);
    }
  }
  for (const id of Object.keys(programmes)) {
    programmes[id].sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  return { channels, programmes };
}

/**
 * Every configured source, merged. Memoized against the set of sources and their
 * fetch stamps, so repeated reads don't re-merge unchanged guides.
 */
export async function getMergedGuide() {
  const urls = await configuredEpgUrls();
  if (!urls.length) return { channels: {}, programmes: {} };

  const loaded = [];
  for (const url of urls) {
    try {
      loaded.push({ url, ...(await loadOrFetchSource(url)) });
    } catch (err) {
      console.warn(`epg: source unavailable ${url}:`, String(err.message || err));
    }
  }

  const signature = loaded.map((entry) => `${entry.url}@${entry.fetchedAt}`).join('|');
  if (mergedCache && mergedCache.signature === signature) return mergedCache.guide;
  const guide = mergeGuides(loaded.map((entry) => entry.guide));
  mergedCache = { signature, guide };
  return guide;
}

// Drop persisted guides for sources that are no longer configured, plus any
// half-written temp file left by a process that died mid-persist — nothing else
// would ever collect those. Only ever removes files this module created, inside
// its own directory.
async function pruneUnconfiguredGuides(urls) {
  const keep = new Set(urls.map((url) => path.basename(guideFilePath(url))));
  let names;
  try {
    names = await fs.readdir(GUIDE_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const filePath = path.join(GUIDE_DIR, name);
    // A temp older than the cutoff belongs to a write that never finished; a
    // recent one may still be in flight (the sidecar channels.xml writes here too).
    if (name.endsWith(TMP_SUFFIX)) {
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_TMP_MS) await fs.unlink(filePath).catch(() => {});
      continue;
    }
    if (!name.startsWith(GUIDE_FILE_PREFIX)) continue;
    if (name.endsWith(GUIDE_FILE_SUFFIX) && keep.has(name)) continue;
    await fs.unlink(filePath).catch(() => {});
  }
}

/**
 * Refresh every configured source, recording per-source health. Sequential: a
 * guide can be hundreds of MB, so one at a time bounds memory and is gentler on
 * upstreams.
 *
 * `maxAgeMs` skips sources whose persisted guide is younger than that — used at
 * boot so restarting the container doesn't re-download guides it already has.
 *
 * A refresh requested while one is running queues exactly one follow-up run, so
 * a source list edited mid-refresh is still picked up (the running pass read the
 * old list).
 */
export function refreshAll({ maxAgeMs = 0 } = {}) {
  if (refreshingAll) {
    refreshQueued = true;
    return refreshingAll;
  }
  // The follow-up must be decided on BOTH outcomes: if a run rejects and the
  // drain is skipped, refreshQueued stays true forever and the queued refresh is
  // silently dropped.
  const drain = (outcome, failed) => {
    refreshingAll = null;
    if (!refreshQueued) {
      if (failed) throw outcome;
      return outcome;
    }
    refreshQueued = false;
    return refreshAll();
  };
  refreshingAll = runRefreshAll(maxAgeMs).then(
    (health) => drain(health, false),
    (err) => drain(err, true)
  );
  return refreshingAll;
}

async function runRefreshAll(maxAgeMs) {
  const urls = await configuredEpgUrls();
  const health = [];
  for (const url of urls) {
    try {
      const entry = await sourceOrRefresh(url, maxAgeMs);
      health.push({
        url,
        ok: true,
        error: '',
        fetchedAt: entry.fetchedAt,
        channelCount: Object.keys(entry.guide.channels || {}).length,
      });
    } catch (err) {
      console.warn(`epg: refresh failed for ${url}:`, String(err.message || err));
      health.push({
        url,
        ok: false,
        error: String(err.message || err),
        fetchedAt: new Date().toISOString(),
        channelCount: 0,
      });
    }
  }
  await writeCollection(HEALTH_COLLECTION, health);
  await pruneUnconfiguredGuides(urls);
  return health;
}

// The stored guide when it is younger than maxAgeMs, else a fresh download.
async function sourceOrRefresh(url, maxAgeMs) {
  if (!maxAgeMs) return refreshSource(url);
  const stored = await loadSource(url);
  if (stored && Date.now() - Date.parse(stored.fetchedAt) < maxAgeMs) return stored;
  return refreshSource(url);
}

/** Per-source status of the last refresh: [{url, ok, error, fetchedAt, channelCount}]. */
export function readSourceHealth() {
  return readCollection(HEALTH_COLLECTION);
}
