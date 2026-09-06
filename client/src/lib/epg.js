// EPG helpers operating on the parsed structure returned by the backend.
import { normalizeName, channelIdCandidates } from '@shared/normalize.js';

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

// A scheduled recording stores the *padded* start (up to 15 minutes before the
// programme, see PADDING_OPTIONS in SettingsPage), so an exact timestamp match would
// never hit. Half an hour is comfortably wider than that padding and far narrower
// than the gap between two airings of the same programme.
const SCHEDULE_MATCH_WINDOW_MS = 30 * 60_000;

// Whether this exact airing already has a recording scheduled. Title alone is not
// enough: a daily programme would show every future airing as scheduled as soon as
// one of them was.
export function isProgrammeScheduled(recordings = [], channelName, programme) {
  if (!programme) return false;
  const programmeStart = Date.parse(programme.start);
  return recordings.some(
    (recording) =>
      recording.channelName === channelName &&
      recording.title === programme.title &&
      Math.abs(Date.parse(recording.start) - programmeStart) < SCHEDULE_MATCH_WINDOW_MS
  );
}

export function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const MS_PER_HOUR = 3_600_000;

// An epg.channels value is `{name, icon}` (current) or a bare display-name string
// (an old-shape response still cached by the service worker). Normalize to the name.
function channelName(value) {
  return typeof value === 'string' ? value : value?.name || '';
}

// Normalized display name → channel id, built once per guide object. A new guide
// is a new object, so the cache invalidates itself; without it every unmatched
// channel rescanned the whole guide on every render of every row.
const nameIndexCache = new WeakMap();

// The alt-name tier, shared by every caller: it is one property of the loaded
// guide, not per-component state. Set once when the guide loads (see loadEpg),
// the same way api.js registers its unauthorized handler.
let sharedAltNames = {};

export function setAltNameIndex(index) {
  sharedAltNames = index && typeof index === 'object' ? index : {};
}

function nameIndexFor(epg) {
  let index = nameIndexCache.get(epg);
  if (index) return index;
  index = new Map();
  for (const [id, value] of Object.entries(epg.channels || {})) {
    const key = normalizeName(channelName(value));
    if (key && !index.has(key)) index.set(key, id);
  }
  nameIndexCache.set(epg, index);
  return index;
}

// Normalized display-name → channel id, or '' when no channel matches.
function channelIdByName(epg, name) {
  const target = normalizeName(name);
  return target ? nameIndexFor(epg).get(target) || '' : '';
}

// Resolve a channel to its EPG key: explicit user override, then exact tvg-id,
// then a normalized display-name match, then an iptv-org alternative name (a
// guide that calls a channel something the playlist does not).
function resolveKey(epg, channel, overrides, altNames) {
  const override = overrides[channel.id];
  if (override) return override;
  const byId = channelIdCandidates(channel.tvgId).find((candidate) => epg.programmes[candidate]);
  if (byId) return byId;
  const normalized = normalizeName(channel.tvgName || channel.name);
  if (!normalized) return '';
  return nameIndexFor(epg).get(normalized) || altNames[normalized] || '';
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
export function programmesForChannel(epg, channel, overrides = {}, altNames = sharedAltNames) {
  if (!epg || !channel) return [];
  const key = resolveKey(epg, channel, overrides, altNames);
  const programmes = (key && epg.programmes[key]) || [];
  if (!programmes.length || !channel.tvgShift) return programmes;
  const shiftMs = channel.tvgShift * MS_PER_HOUR;
  const shifted = (iso) => (iso ? new Date(Date.parse(iso) + shiftMs).toISOString() : iso);
  return programmes.map((p) => ({ ...p, start: shifted(p.start), stop: shifted(p.stop) }));
}
