// Minimal, dependency-free M3U / M3U8 (EXTM3U) playlist parser.
// Extracts: name, group-title, tvg-id, tvg-name, tvg-logo, and the stream URL.

const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

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

/**
 * Parse raw M3U text into a normalized array of channel objects.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseM3U(text = '') {
  const lines = text.split(/\r?\n/);
  const channels = [];
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
      current = {
        name,
        tvgId: attrs['tvg-id'] || '',
        tvgName: attrs['tvg-name'] || name,
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || 'Uncategorized',
        httpUserAgent: attrs['http-user-agent'] || '',
        httpReferrer: attrs['http-referrer'] || '',
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
    } else {
      // This is a URL line.
      const url = line;
      const base = current || { name: `Channel ${idx + 1}`, tvgId: '', tvgName: '', logo: '', group: 'Uncategorized', httpUserAgent: '', httpReferrer: '' };
      channels.push({
        id: `${idx}-${base.tvgId || base.name}`.replace(/[^a-zA-Z0-9-_]/g, '_'),
        name: base.name,
        tvgId: base.tvgId,
        tvgName: base.tvgName,
        logo: base.logo,
        group: base.group,
        url,
        kind: guessKind(base.group, base.name, url),
        httpUserAgent: base.httpUserAgent || '',
        httpReferrer: base.httpReferrer || '',
      });
      idx += 1;
      current = null;
    }
  }
  return channels;
}

export default parseM3U;
