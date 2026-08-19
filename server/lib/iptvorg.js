// The iptv-org public dataset, reduced to what the sidecar mapping needs.
//
// iptv-org publishes the two things required to turn "the channels this install
// has" into a grabber job: channels.json (canonical ids, names and alt_names per
// country) and guides.json (which grabber site carries which channel).
//
// Both are large — channels.json ~10 MB / 41k records, guides.json ~26 MB / 180k
// records — so nothing here keeps a raw dataset alive. Each file is parsed,
// reduced to the wanted countries, and the parsed form dropped; only the small
// per-country index survives. The raw downloads are cached on disk (gzipped) so a
// country change re-indexes without re-downloading.
import { promises as fs, createReadStream } from 'fs';
import path from 'path';
import zlib from 'zlib';

import { writeFileAtomic, DATA_DIR } from './store.js';
import { fetchToBuffer } from './http.js';
import { normalizeName } from './epgmatch.js';

const API_BASE = 'https://iptv-org.github.io/api';
const CHANNELS_DATASET = 'channels.json';
const GUIDES_DATASET = 'guides.json';
const DATASET_DIR = path.join(DATA_DIR, 'iptv-org');
const DATASET_TTL_MS = 24 * 60 * 60 * 1000;
// channels.json is ~10 MB and guides.json ~26 MB today; the cap leaves headroom
// without allowing an unbounded download.
const DATASET_MAX_BYTES = 96 * 1024 * 1024;
const DATASET_FETCH_TIMEOUT_MS = 120_000;

// The app's canonical country codes are ISO, and client/src/lib/country.js folds
// uk into gb. iptv-org uses UK for the United Kingdom, with ids like BBCOne.uk —
// so the two disagree for exactly this code.
const IPTV_ORG_COUNTRY_CODE = { gb: 'UK' };

export function iptvOrgCountryCode(countryCode) {
  return IPTV_ORG_COUNTRY_CODE[countryCode] || countryCode.toUpperCase();
}

function datasetPath(name) {
  return path.join(DATASET_DIR, `${name}.gz`);
}

/**
 * Walk a single-line JSON array of flat objects, yielding one at a time.
 *
 * guides.json is ~26 MB and ~180k records; JSON.parse of the whole thing holds
 * every record live at once and overruns the heap a 1 GB container allows (the
 * documented default). Scanning the stream and parsing each object separately
 * keeps the peak at one chunk, and the caller keeps only the few it wants.
 */
export async function* streamArrayObjects(readable) {
  let buffer = '';
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  // Where the unscanned part of `buffer` begins. The scanner carries state
  // (depth, string) across chunks, so a character must be visited exactly once —
  // rescanning a prefix double-counts its braces and depth never closes.
  let scanned = 0;

  for await (const chunk of readable) {
    buffer += chunk;
    let consumed = 0;
    for (let i = scanned; i < buffer.length; i += 1) {
      const character = buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          yield JSON.parse(buffer.slice(start, i + 1));
          consumed = i + 1;
          start = -1;
        }
      }
    }
    scanned = buffer.length - consumed;
    buffer = buffer.slice(consumed);
    if (start >= 0) start -= consumed;
  }
}

// Records of a cached dataset, or null when it is missing or past its TTL.
async function readCachedDataset(name) {
  const filePath = datasetPath(name);
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || Date.now() - stat.mtimeMs > DATASET_TTL_MS) return null;
  const gunzip = zlib.createGunzip();
  gunzip.setEncoding('utf8');
  createReadStream(filePath).pipe(gunzip);
  return streamArrayObjects(gunzip);
}

// The dataset as a parsed array — from the disk cache while it is fresh, else
// downloaded and cached. Callers must drop the reference when done with it.
// `cachedOnly` returns null rather than downloading: request-path callers must
// never pay for 36 MB of JSON, so they degrade and let a warm fill it in.
async function loadDataset(name, cachedOnly) {
  const cached = await readCachedDataset(name);
  if (cached) return cached;
  if (cachedOnly) return null;

  const buf = await fetchToBuffer(`${API_BASE}/${name}`, {
    timeoutMs: DATASET_FETCH_TIMEOUT_MS,
    maxBytes: DATASET_MAX_BYTES,
  });
  await fs.mkdir(DATASET_DIR, { recursive: true });
  await writeFileAtomic(datasetPath(name), zlib.gzipSync(buf));
  // Read it back as a stream rather than parsing the buffer we already hold:
  // one path, and the whole array never becomes live objects at once.
  return readCachedDataset(name);
}

// A channel that has shut down is useless to grab; one that was replaced should
// map to its successor instead.
function resolveLiveChannel(channel, byId) {
  let current = channel;
  for (let hop = 0; hop < 4 && current?.closed && current.replaced_by; hop += 1) {
    const next = byId.get(current.replaced_by);
    if (!next) break;
    current = next;
  }
  return current?.closed ? null : current;
}

/**
 * Build the lookup for a set of app country codes.
 * @returns {Promise<{byId: Map, byCountryName: Map, guidesByChannel: Map}>}
 */
// The built index, memoized by the country set it was built for. Rebuilding it
// means gunzipping and parsing ~36 MB, and this sits on the page-load path via
// /api/epg/altnames — the index itself is small, so holding it is the cheap part.
let indexCache = null;

function indexCacheKey(countries) {
  return [...countries].sort().join(',');
}

export async function loadIptvOrgIndex(countries, { cachedOnly = false } = {}) {
  const cacheKey = indexCacheKey(countries);
  if (indexCache && indexCache.key === cacheKey && Date.now() - indexCache.builtAt < DATASET_TTL_MS) {
    return indexCache.value;
  }
  const built = await buildIptvOrgIndex(countries, cachedOnly);
  if (built) indexCache = { key: cacheKey, builtAt: Date.now(), value: built };
  return built;
}

async function buildIptvOrgIndex(countries, cachedOnly) {
  // Keyed BOTH ways: the dataset is filtered with iptv-org's codes, but callers
  // look channels up with the app's (gb, not UK), so the name index is keyed by
  // the app's code — otherwise no UK channel could ever resolve.
  const appCodeByIptvOrgCode = new Map(countries.map((country) => [iptvOrgCountryCode(country), country]));
  const byId = new Map();
  const byCountryName = new Map();

  {
    const channels = await loadDataset(CHANNELS_DATASET, cachedOnly);
    if (!channels) return null;
    // Only the wanted countries are retained — a few hundred of ~41k records.
    const inScope = [];
    for await (const channel of channels) {
      if (appCodeByIptvOrgCode.has(channel.country)) inScope.push(channel);
    }
    // Indexed by id first so replaced_by can be followed within the country.
    for (const channel of inScope) byId.set(channel.id, channel);
    for (const channel of inScope) {
      const live = resolveLiveChannel(channel, byId);
      if (!live) continue;
      const countryCode = appCodeByIptvOrgCode.get(live.country) || live.country.toLowerCase();
      if (!byCountryName.has(countryCode)) byCountryName.set(countryCode, new Map());
      const names = byCountryName.get(countryCode);
      for (const candidate of [live.name, ...(live.alt_names || [])]) {
        const key = normalizeName(candidate);
        if (key && !names.has(key)) names.set(key, live);
      }
    }
  }

  const guidesByChannel = new Map();
  {
    const guides = await loadDataset(GUIDES_DATASET, cachedOnly);
    if (!guides) return null;
    // Most records carry no channel (they describe a site's own listing only) and
    // most channels are in countries this install does not have.
    for await (const guide of guides) {
      if (!guide.channel || !byId.has(guide.channel)) continue;
      if (!guide.site || !guide.site_id) continue;
      if (!guidesByChannel.has(guide.channel)) guidesByChannel.set(guide.channel, []);
      guidesByChannel.get(guide.channel).push({
        site: guide.site,
        siteId: String(guide.site_id),
        lang: guide.lang || '',
      });
    }
  }

  return { byId, byCountryName, guidesByChannel };
}

let warming = null;

/**
 * Fill the dataset cache in the background, once. Request-path callers use
 * `cachedOnly` and call this when they come up empty, so the feature that needed
 * the dataset works from the next request on without ever blocking on 36 MB.
 */
export function warmIptvOrgDataset(countries) {
  if (warming) return warming;
  indexCache = null; // a warm exists because the cached-only build came up empty
  warming = loadIptvOrgIndex(countries)
    .then(() => true)
    .catch((err) => {
      console.warn('iptv-org: dataset warm failed:', String(err.message || err));
      return false;
    })
    .finally(() => {
      warming = null;
    });
  return warming;
}

/** Drop the cached datasets so the next index build re-downloads them. */
export async function clearIptvOrgCache() {
  indexCache = null;
  await fs.rm(DATASET_DIR, { recursive: true, force: true });
}
