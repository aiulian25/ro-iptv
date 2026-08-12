// Client-side M3U parser (used for local file uploads so we don't round-trip to the server).
import { hashStr } from './uid';

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

// Content-derived channel id — stable across playlist refreshes regardless of
// ordering. `seen` (a Map) deduplicates identical (tvgId,name,url) tuples within
// one playlist by suffixing -2, -3, …
export function channelId(channel, seen) {
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
  while ((m = ATTR_RE.exec(line)) !== null) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

export function guessKind(group = '', name = '', url = '') {
  const g = group.toLowerCase();
  const n = name.toLowerCase();
  const u = url.toLowerCase();
  // "FM"/"AM"/"radio" in the channel name (e.g. "Europa FM") signal radio too.
  if (/\bradio\b|\bfm\b|\bam\b/.test(n) || /radio|\bfm\b|\bam\b/.test(g)) return 'radio';
  if (/\.(mp3|aac|ogg)(\?|$)/.test(u)) return 'radio';
  return 'live';
}

// Effective kind for a stored channel: the playlist's contentKind override wins,
// then the explicit radio="true" playlist attribute, then heuristics.
export function effectiveKind(playlistContentKind, channel) {
  if (playlistContentKind === 'live' || playlistContentKind === 'radio') return playlistContentKind;
  if (channel.radio) return 'radio';
  return guessKind(channel.group, channel.name, channel.url);
}

export function parseM3U(text = '') {
  const lines = text.split(/\r?\n/);
  const channels = [];
  const seen = new Map();
  let current = null;
  let idx = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = parseAttributes(line);
      const commaIdx = line.lastIndexOf(',');
      const name = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : attrs['tvg-name'] || 'Unknown';
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
      // Per-stream HTTP headers some streams require to play.
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
      continue;
    } else {
      const base = current || { name: `Channel ${idx + 1}`, tvgId: '', tvgName: '', logo: '', group: 'Uncategorized', httpUserAgent: '', httpReferrer: '', radio: false, chno: null, tvgShift: 0, catchup: '', catchupSource: '', catchupDays: 0 };
      channels.push({
        id: channelId({ ...base, url: line }, seen),
        name: base.name,
        tvgId: base.tvgId,
        tvgName: base.tvgName,
        logo: base.logo,
        group: base.group,
        url: line,
        kind: base.radio ? 'radio' : guessKind(base.group, base.name, line),
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
