// Build provider archive ("catchup"/timeshift) URLs from a channel's catchup
// attributes (parsed by the M3U parser: catchup, catchupSource, catchupDays).

const pad = (n) => String(n).padStart(2, '0');

// A channel advertises an archive when it has a catchup mode or a source template.
export function supportsCatchup(ch) {
  return !!(ch.catchup || ch.catchupSource);
}

// Replace the placeholder tokens used by the `default`/`append` schemes. The
// `${...}` forms are substituted before the bare `{...}` forms so a `${start}`
// isn't partially rewritten by the `{start}` pass.
function substitute(source, startMs, { start, end, durSec, now }) {
  const d = new Date(startMs);
  const tokens = {
    '${start}': start,
    '${end}': end,
    '${timestamp}': start,
    '{utc}': start,
    '{start}': start,
    '{end}': end,
    '{lutc}': now,
    '{now}': now,
    '{duration}': durSec,
    '{durmin}': Math.ceil(durSec / 60),
    '{Y}': d.getFullYear(),
    '{m}': pad(d.getMonth() + 1),
    '{d}': pad(d.getDate()),
    '{H}': pad(d.getHours()),
    '{M}': pad(d.getMinutes()),
    '{S}': pad(d.getSeconds()),
  };
  let out = source;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(String(value));
  }
  return out;
}

// Xtream Codes timeshift path rewrite:
//   /live/<u>/<p>/<id>.m3u8|ts → /timeshift/<u>/<p>/<durMin>/<YYYY-MM-DD:HH-MM>/<id>.m3u8
function xtreamTimeshift(url, startMs, durSec) {
  const m = url.match(/^(https?:\/\/[^/]+)\/live\/([^/]+)\/([^/]+)\/([^/.]+)\.(m3u8|ts)$/);
  if (!m) return null;
  const [, host, user, pass, id] = m;
  const d = new Date(startMs);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}:${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return `${host}/timeshift/${user}/${pass}/${Math.ceil(durSec / 60)}/${stamp}/${id}.m3u8`;
}

// Build the archive URL for the window [startMs, endMs). Returns null when the
// channel's catchup config can't produce one.
export function catchupUrl(ch, startMs, endMs) {
  const url = ch.url || '';
  const start = Math.floor(startMs / 1000);
  const end = Math.floor(endMs / 1000);
  const durSec = Math.max(0, end - start);
  const now = Math.floor(Date.now() / 1000);
  const type = String(ch.catchup || '').toLowerCase().trim();

  if (type === 'shift' || type === 'timeshift') {
    return `${url}${url.includes('?') ? '&' : '?'}utc=${start}&lutc=${now}`;
  }
  if (type === 'flussonic' || type === 'fs') {
    const archived = url.replace(/\/[^/]+\.m3u8/, `/archive-${start}-${durSec}.m3u8`);
    return archived === url ? null : archived; // no .m3u8 segment → can't build an archive URL
  }
  if (type === 'xc' || type === 'xtream') {
    return xtreamTimeshift(url, startMs, durSec);
  }
  if (type === 'append') {
    return ch.catchupSource ? url + substitute(ch.catchupSource, startMs, { start, end, durSec, now }) : null;
  }

  // 'default', an unknown type, or an empty type — as long as a source template
  // exists, substitute it and resolve relative templates against the channel URL.
  if (ch.catchupSource) {
    const src = substitute(ch.catchupSource, startMs, { start, end, durSec, now });
    try {
      return new URL(src, url || undefined).toString();
    } catch {
      return src;
    }
  }
  return null;
}
