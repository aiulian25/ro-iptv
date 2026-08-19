// Shoutcast/Icecast "now playing" over the ICY protocol.
//
// A radio stream that carries no XMLTV guide still knows what it is playing: ask
// for it with `Icy-MetaData: 1` and the server interleaves metadata into the
// audio — `icy-metaint` bytes of audio, then a length byte (in 16-byte units),
// then a block containing `StreamTitle='Artist - Song';`. The response headers
// also carry the station's own name, bitrate and genre.
//
// This reads exactly one metadata block and hangs up. It is a metadata probe,
// never a second audio stream: the caps below bound it to a few tens of KB.
import { FETCH_HEADERS, guardedFetch } from './http.js';

// A probe reads one metadata block; metaint is typically 8-16 KB. The ceiling is
// a backstop against a server that advertises an absurd interval.
const MAX_PROBE_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 5000;
// Track changes are minutes apart, so a short cache collapses every listener's
// polling into one upstream connection without ever showing a stale song.
const CACHE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 32;
// ICY metadata lengths are expressed in 16-byte units.
const METADATA_LENGTH_UNIT = 16;
// Servers use 8-16 KB; anything far beyond that is a malformed or hostile header.
const MAX_METAINT = 64 * 1024;
// An empty block means "nothing changed since the last one", so a probe that
// lands on one looks a little further before giving up.
const MAX_METADATA_BLOCKS = 3;
// The value runs to the ICY field delimiter, NOT to the next quote: apostrophes
// are common in titles ("Guns N' Roses") and the protocol has no way to escape them.
const STREAM_TITLE_RE = /StreamTitle='(.*?)';/;

const cache = new Map();
const inFlight = new Map();

function cacheGet(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  return null;
}

function cacheSet(url, data) {
  cache.set(url, { at: Date.now(), data });
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

// Pull at least `count` bytes out of the reader, returning them plus whatever
// arrived with them. Null when the stream ends or the budget runs out first.
// Chunks accumulate in an array and are joined once, rather than re-copying the
// whole buffer per chunk (the same shape as fetchToBuffer in lib/http.js).
async function consume(reader, count, carried, budget) {
  if (carried.length >= count) return carried;
  const parts = [carried];
  let length = carried.length;
  while (length < count) {
    if (budget.read > MAX_PROBE_BYTES) return null;
    const { done, value } = await reader.read();
    if (done) return null;
    budget.read += value.length;
    parts.push(Buffer.from(value));
    length += value.length;
  }
  return Buffer.concat(parts, length);
}

// ICY predates UTF-8 and names no charset. Icecast emits UTF-8; Shoutcast v1 and
// the encoders built on it emit latin1 — so trust UTF-8 and fall back when it
// decodes to replacement characters.
function decodeMetadata(block) {
  const text = block.toString('utf8');
  return (text.includes('�') ? block.toString('latin1') : text).replace(/\0+$/, '');
}

// Skip the audio, read the metadata block that follows it, and pull the title out.
async function readStreamTitle(reader, metaint) {
  const budget = { read: 0 };
  let carried = Buffer.alloc(0);

  for (let attempt = 0; attempt < MAX_METADATA_BLOCKS; attempt += 1) {
    const afterAudio = await consume(reader, metaint + 1, carried, budget);
    if (!afterAudio) return '';
    const metadataLength = afterAudio[metaint] * METADATA_LENGTH_UNIT;
    const rest = afterAudio.subarray(metaint + 1);
    if (!metadataLength) {
      carried = rest;
      continue;
    }
    const block = await consume(reader, metadataLength, rest, budget);
    if (!block) return '';
    const match = STREAM_TITLE_RE.exec(decodeMetadata(block.subarray(0, metadataLength)));
    if (match) return match[1].trim();
    carried = block.subarray(metadataLength);
  }
  return '';
}

async function probe(url, userAgent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const station = { title: '', name: '', bitrate: '', genre: '' };
  try {
    const response = await guardedFetch(url, {
      headers: { ...FETCH_HEADERS, ...(userAgent ? { 'User-Agent': userAgent } : {}), 'Icy-MetaData': '1' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`upstream ${response.status}`);

    station.name = response.headers.get('icy-name') || '';
    station.bitrate = response.headers.get('icy-br') || '';
    station.genre = response.headers.get('icy-genre') || '';

    const metaint = parseInt(response.headers.get('icy-metaint') || '0', 10);
    if (!response.body) return station;
    // No interleaved metadata (or an implausible interval): the headers are all
    // this station offers.
    if (metaint > 0 && metaint <= MAX_METAINT) {
      station.title = await readStreamTitle(response.body.getReader(), metaint);
    }
    return station;
  } finally {
    clearTimeout(timer);
    // One teardown for every exit — a finished read, a non-2xx throw, or an error
    // out of the reader. Without it a failed probe leaves the station streaming
    // into a body nobody is reading.
    controller.abort();
  }
}

/**
 * What a radio stream says it is playing right now.
 * @returns {Promise<{title: string, name: string, bitrate: string, genre: string}>}
 */
export async function probeNowPlaying(url, userAgent = '') {
  // The agent is part of the key: a station can answer differently per agent, so
  // one channel's result must not be served to a channel that asks as someone else.
  const key = `${url}\n${userAgent}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const running = probe(url, userAgent)
    .then((station) => {
      cacheSet(key, station);
      return station;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, running);
  return running;
}
