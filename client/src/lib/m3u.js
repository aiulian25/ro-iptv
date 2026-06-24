// Client-side M3U parser (used for local file uploads so we don't round-trip to the server).
const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;

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

export function parseM3U(text = '') {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;
  let idx = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = parseAttributes(line);
      const commaIdx = line.lastIndexOf(',');
      const name = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : attrs['tvg-name'] || 'Unknown';
      current = {
        name,
        tvgId: attrs['tvg-id'] || '',
        tvgName: attrs['tvg-name'] || name,
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || 'Uncategorized',
      };
    } else if (line.startsWith('#EXTGRP:')) {
      if (current) current.group = line.slice(8).trim() || current.group;
    } else if (line.startsWith('#')) {
      continue;
    } else {
      const base = current || { name: `Channel ${idx + 1}`, tvgId: '', tvgName: '', logo: '', group: 'Uncategorized' };
      channels.push({
        id: `${idx}-${base.tvgId || base.name}`.replace(/[^a-zA-Z0-9-_]/g, '_'),
        name: base.name,
        tvgId: base.tvgId,
        tvgName: base.tvgName,
        logo: base.logo,
        group: base.group,
        url: line,
        kind: guessKind(base.group, base.name, line),
      });
      idx += 1;
      current = null;
    }
  }
  return channels;
}

export default parseM3U;
