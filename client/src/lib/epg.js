// EPG helpers operating on the parsed structure returned by the backend.

export function findNowNext(programmes = [], at = new Date()) {
  if (!programmes || !programmes.length) return { now: null, next: null };
  const t = at.getTime();
  let now = null;
  let next = null;
  for (let i = 0; i < programmes.length; i++) {
    const p = programmes[i];
    const start = p.start ? new Date(p.start).getTime() : 0;
    const stop = p.stop ? new Date(p.stop).getTime() : 0;
    if (start <= t && t < stop) {
      now = p;
      next = programmes[i + 1] || null;
      break;
    }
    if (start > t) {
      next = p;
      break;
    }
  }
  return { now, next };
}

export function progressPct(programme, at = new Date()) {
  if (!programme || !programme.start || !programme.stop) return 0;
  const start = new Date(programme.start).getTime();
  const stop = new Date(programme.stop).getTime();
  const t = at.getTime();
  if (t <= start) return 0;
  if (t >= stop) return 100;
  return Math.round(((t - start) / (stop - start)) * 100);
}

export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const MS_PER_HOUR = 3_600_000;

// Fold a channel name to a comparison key: lowercase, strip diacritics, drop
// quality suffixes (HD/FHD/UHD/4K/8K/SD) and all non-alphanumerics. So
// "Digi 24 HD", "Digi24" and "digi-24" all collapse to "digi24".
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\b(hd|fhd|uhd|4k|8k|sd)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// An epg.channels value is `{name, icon}` (current) or a bare display-name string
// (an old-shape response still cached by the service worker). Normalize to the name.
function channelName(value) {
  return typeof value === 'string' ? value : value?.name || '';
}

// Normalized display-name → channel id, or '' when no channel matches.
function channelIdByName(epg, name) {
  const target = normalizeName(name);
  if (!target) return '';
  for (const [id, value] of Object.entries(epg.channels || {})) {
    if (normalizeName(channelName(value)) === target) return id;
  }
  return '';
}

// Resolve a channel to its EPG key: explicit user override, then exact tvg-id,
// then a normalized display-name match.
function resolveKey(epg, channel, overrides) {
  const override = overrides[channel.id];
  if (override) return override;
  if (channel.tvgId && epg.programmes[channel.tvgId]) return channel.tvgId;
  return channelIdByName(epg, channel.tvgName || channel.name);
}

// The EPG channel-icon URL for a channel (logo fallback when the playlist has no
// tvg-logo). Resolves by tvg-id, then normalized display-name; '' when unknown.
export function epgIconFor(epg, channel) {
  if (!epg || !channel) return '';
  const channels = epg.channels || {};
  const key = channel.tvgId && channels[channel.tvgId] ? channel.tvgId : channelIdByName(epg, channel.tvgName || channel.name);
  const value = channels[key];
  return value && typeof value === 'object' ? value.icon || '' : '';
}

// Build a lookup of EPG programmes for a channel: per-channel override, then
// tvg-id, then normalized name. A channel's tvg-shift (hours) offsets the times.
export function programmesForChannel(epg, channel, overrides = {}) {
  if (!epg || !channel) return [];
  const key = resolveKey(epg, channel, overrides);
  const programmes = (key && epg.programmes[key]) || [];
  if (!programmes.length || !channel.tvgShift) return programmes;
  const shiftMs = channel.tvgShift * MS_PER_HOUR;
  const shifted = (iso) => (iso ? new Date(Date.parse(iso) + shiftMs).toISOString() : iso);
  return programmes.map((p) => ({ ...p, start: shifted(p.start), stop: shifted(p.stop) }));
}
