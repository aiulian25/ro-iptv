import { sidecarUrl } from './sidecar.js';
import { safeDiagnostic, sourceId, sourceHealthDiagnostic } from './redact.js';
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
import { promisify } from 'util';
import crypto from 'crypto';

import { readCollection, writeCollection, writeFileAtomic, TMP_SUFFIX, DATA_DIR } from './store.js';
import { FETCH_HEADERS, isValidUrl, isBlockedTarget, fetchToBuffer } from './http.js';
import { mergeGuides } from '../../shared/normalize.js';

// zlib's sync calls block the event loop for the whole compress/decompress; a country
// pack is ~13 MB gzipped and ~72 MB of XML, so every refresh froze playback. The async
// forms do the same work on the libuv threadpool instead.
const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

// Parsing a country pack is ~5s of straight CPU. Run on the event loop it froze
// playback for every viewer at each refresh, so it happens in a worker instead. The
// worker is handed the RAW download: decompressing and decoding are its job too, so
// the 63 MB XML string is never materialised on this thread.
import { parseGuideOffThread, EPG_MAX_DECOMPRESSED } from './epgparse.js';
export { EPG_MAX_DECOMPRESSED };

export const PARSED_GUIDE_SCHEMA_VERSION = 2;
const HEALTH_COLLECTION = 'epg-health';
const STATE_COLLECTION = 'state';
const SETTINGS_KEY = 'settings';
const GUIDE_DIR = path.join(DATA_DIR, 'epg');
const GUIDE_FILE_PREFIX = 'guide-';
const GUIDE_FILE_SUFFIX = '.json.gz';

export const EPG_MAX_DOWNLOAD = 200 * 1024 * 1024; // 200 MB compressed
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
export async function configuredEpgUrls(settings) {
  if (!settings) {
    const state = await readCollection(STATE_COLLECTION);
    settings = state.find((entry) => entry.key === SETTINGS_KEY)?.value || {};
  }
  const configured = Array.isArray(settings.epgUrls) ? settings.epgUrls : [];
  // EPG_SIDECAR_URL is the optional iptv-org grabber running alongside this app;
  // it is a source like any other, so it merges, reports health and refreshes
  // with the rest rather than needing its own path.
  const urls = [...configured, settings.epgUrl, process.env.EPG_URL, sidecarUrl]
    .map((url) => (url || '').trim())
    .filter(Boolean);
  return [...new Set(urls)];
}

// Download a guide's raw bytes. Enforces the same target rules as the request-path
// endpoints, and caps the transfer WHILE reading rather than after, so an oversized or
// endless response can't exhaust memory before the check. Decompressing and parsing
// belong to the worker, so they never run on this thread.
async function fetchGuideBytes(url, timeoutMs) {
  if (!isValidUrl(url)) throw new Error('invalid EPG url');
  if (isBlockedTarget(url)) throw new Error('refusing a private-network EPG url');

  return fetchToBuffer(url, { headers: FETCH_HEADERS, timeoutMs, maxBytes: EPG_MAX_DOWNLOAD });
}

/** Download + parse one source without persisting it. */
export async function fetchAndParseGuide(url, { timeoutMs = EPG_FETCH_TIMEOUT_MS } = {}) {
  return parseGuideOffThread(await fetchGuideBytes(url, timeoutMs));
}

// Persist a parsed guide next to the URL it came from, so a load can prove the
// file belongs to the URL it was asked for. Atomic tmp+rename, as store.js does.
async function persistGuide(url, guide, fetchedAt, revision) {
  await fs.mkdir(GUIDE_DIR, { recursive: true });
  await writeFileAtomic(guideFilePath(url), await gzip(JSON.stringify({ schemaVersion: PARSED_GUIDE_SCHEMA_VERSION, url, fetchedAt, revision, guide })));
}

/** Fetch a source, parse it, persist it, and cache it. Returns {fetchedAt, guide}. */
export function refreshSource(url, options = {}) {
  if (inFlight.has(url)) return inFlight.get(url);
  const pending = doRefreshSource(url, options).finally(() => inFlight.delete(url));
  inFlight.set(url, pending);
  return pending;
}

async function doRefreshSource(url, options) {
  try {
    const guide = await fetchAndParseGuide(url, options);
    const fetchedAt = new Date().toISOString();
    const revision = crypto.randomUUID();
    await persistGuide(url, guide, fetchedAt, revision);
    const entry = { fetchedAt, revision, guide };
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
  let stored, raw;
  try {
    raw = await gunzip(await fs.readFile(guideFilePath(url)));
    stored = JSON.parse(raw.toString('utf8'));
  } catch {
    return null; // never fetched, unreadable, or corrupt — the caller refetches
  }
  // The filename is a digest; the record names the URL it was built from.
  if (!stored || stored.schemaVersion !== PARSED_GUIDE_SCHEMA_VERSION || stored.url !== url || !stored.guide) return null;
  const entry = { fetchedAt: stored.fetchedAt, guide: stored.guide,
    revision: stored.revision || crypto.createHash('sha256').update(raw).digest('hex') };
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
  return refreshSource(url, { timeoutMs: EPG_REQUEST_FETCH_TIMEOUT_MS });
}

/**
 * Every configured source, merged. Memoized against the set of sources and their
 * fetch stamps, so repeated reads don't re-merge unchanged guides.
 */
export function epgSourceRevision(urls) {
  return crypto.createHash('sha256').update(JSON.stringify(urls)).digest('hex');
}

export async function getMergedGuide() {
  return (await getMergedGuideSnapshot()).guide;
}

// Capture the source set once: guide contents and revision must describe the
// same configuration even if another device saves settings during a cold fetch.
export async function getMergedGuideSnapshot(urls = null) {
  urls ??= await configuredEpgUrls();

  const loaded = [];
  for (const url of urls) {
    try {
      loaded.push({ url, ...(await loadOrFetchSource(url)) });
    } catch (err) {
      console.warn(`epg: source unavailable ${sourceId(url)}:`, safeDiagnostic(err));
    }
  }

  const signature = loaded.map((entry) => `${entry.url}@${entry.revision}`).join('|');
  if (!mergedCache || mergedCache.signature !== signature) {
    mergedCache = { signature, guide: mergeGuides(loaded.map((entry) => entry.guide)) };
  }
  return { guide: mergedCache.guide, sourceRevision: epgSourceRevision(urls),
    guideRevision: crypto.createHash('sha256').update(signature).digest('hex'),
    sourceCount: urls.length, failedSourceCount: urls.length - loaded.length,
    refreshState: loaded.length === urls.length ? 'ready' : 'partial' };
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
        sourceId: sourceId(url),
        ok: true,
        error: '',
        fetchedAt: entry.fetchedAt,
        channelCount: Object.keys(entry.guide.channels || {}).length,
      });
    } catch (err) {
      console.warn(`epg: refresh failed for ${sourceId(url)}:`, safeDiagnostic(err));
      health.push({
        sourceId: sourceId(url),
        ok: false,
        error: safeDiagnostic(err),
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

/** Per-source status, identified without persisting provider credentials. */
export async function readSourceHealth() {
  return (await readCollection(HEALTH_COLLECTION)).map(sourceHealthDiagnostic);
}
