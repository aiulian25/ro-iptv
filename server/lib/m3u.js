// Minimal, dependency-free M3U / M3U8 (EXTM3U) playlist parser.
// Extracts: name, group-title, tvg-id, tvg-name, tvg-logo, and the stream URL.

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

// A playlist entry is only a stream if it carries a scheme (http, https, rtmp,
// rtsp, udp, …). Every channel is fetched over the network, so a schemeless line
// could never have played anyway.
const STREAM_URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// djb2 hash (unsigned, base36) — short content hash for stable channel ids.
// Duplicated from client/src/lib/uid.js (the server has no shared lib with the client).
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Content-derived channel id — stable across playlist refreshes regardless of
// ordering. `seen` (a Map) deduplicates identical (tvgId,name,url) tuples within
// one playlist by suffixing -2, -3, …
function channelId(channel, seen) {
  const slug = String(channel.tvgId || channel.name)
    .replace(/[^a-zA-Z0-9-_]/g, '_')
    .slice(0, 40);
  let id = `${slug}-${hashStr(`${channel.tvgId}|${channel.name}|${channel.url}`)}`;
  const duplicates = seen.get(id) || 0;
  seen.set(id, duplicates + 1);
  if (duplicates) id = `${id}-${duplicates + 1}`;
  return id;
}

function parseAttributes(line) {
  const attrs = {};
  let m;
  while ((m = ATTR_RE.exec(line)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

function guessKind(groupTitle = '', name = '', url = '') {
  const g = groupTitle.toLowerCase();
  const n = name.toLowerCase();
  const u = url.toLowerCase();
  if (/\bradio\b|\bfm\b|\bam\b/.test(n) || /radio|\bfm\b|\bam\b/.test(g)) return 'radio';
  if (/\.(mp3|aac|ogg)(\?|$)/.test(u)) return 'radio';
  return 'live';
}

// Effective kind for a stored channel: the playlist's contentKind override wins,
// then the explicit radio="true" playlist attribute, then heuristics.
// Duplicated from client/src/lib/m3u.js so the server-side channel index routes
// channels to Live TV / Radio exactly as the client does.
export function effectiveKind(playlistContentKind, channel) {
  if (playlistContentKind === 'live' || playlistContentKind === 'radio') return playlistContentKind;
  if (channel.radio) return 'radio';
  return guessKind(channel.group, channel.name, channel.url);
}

/**
 * Parse raw M3U text into a normalized array of channel objects.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseM3U(text = '') {
  const lines = text.split(/\r?\n/);
  const channels = [];
  const seen = new Map();
  let current = null;
  let idx = 0;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = parseAttributes(line);
      const commaIdx = line.lastIndexOf(',');
      const name = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : (attrs['tvg-name'] || 'Unknown');
      const channelNumber = parseInt(attrs['tvg-chno'], 10);
      current = {
        name,
        tvgId: attrs['tvg-id'] || '',
        tvgName: attrs['tvg-name'] || name,
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || 'Uncategorized',
        httpUserAgent: attrs['http-user-agent'] || '',
        httpReferrer: attrs['http-referrer'] || '',
        radio: attrs['radio'] === 'true',
        chno: Number.isNaN(channelNumber) ? null : channelNumber,
        tvgShift: parseFloat(attrs['tvg-shift']) || 0,
        catchup: attrs['catchup'] || '',
        catchupSource: attrs['catchup-source'] || '',
        catchupDays: parseInt(attrs['catchup-days'], 10) || 0,
      };
    } else if (line.startsWith('#EXTGRP:')) {
      if (current) current.group = line.slice(8).trim() || current.group;
    } else if (line.startsWith('#EXTVLCOPT:')) {
      // Per-stream playback options — capture the HTTP headers some streams need.
      if (current) {
        const opt = line.slice('#EXTVLCOPT:'.length);
        const eq = opt.indexOf('=');
        if (eq !== -1) {
          const k = opt.slice(0, eq).trim().toLowerCase();
          const v = opt.slice(eq + 1).trim();
          if (k === 'http-user-agent') current.httpUserAgent = v;
          else if (k === 'http-referrer') current.httpReferrer = v;
        }
      }
    } else if (line.startsWith('#')) {
      // Other directives (#KODIPROP, etc.) — ignore for now.
      continue;
    } else if (!STREAM_URL_RE.test(line)) {
      // Not a stream URL. Playlists in the wild carry `;` section banners and stray
      // notes, and treating those as URLs invented a phantom channel per line —
      // unplayable, unnamed, and counted in the channel total.
      continue;
    } else {
      const url = line;
      const base = current || { name: `Channel ${idx + 1}`, tvgId: '', tvgName: '', logo: '', group: 'Uncategorized', httpUserAgent: '', httpReferrer: '', radio: false, chno: null, tvgShift: 0, catchup: '', catchupSource: '', catchupDays: 0 };
      channels.push({
        id: channelId({ ...base, url }, seen),
        name: base.name,
        tvgId: base.tvgId,
        tvgName: base.tvgName,
        logo: base.logo,
        group: base.group,
        url,
        kind: base.radio ? 'radio' : guessKind(base.group, base.name, url),
        httpUserAgent: base.httpUserAgent || '',
        httpReferrer: base.httpReferrer || '',
        radio: base.radio,
        chno: base.chno,
        tvgShift: base.tvgShift,
        catchup: base.catchup,
        catchupSource: base.catchupSource,
        catchupDays: base.catchupDays,
      });
      idx += 1;
      current = null;
    }
  }
  return channels;
}

export default parseM3U;
