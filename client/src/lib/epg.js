// EPG helpers operating on the parsed structure returned by the backend.
import { programmeInWindow, canScheduleProgramme } from '@shared/epg-time.js';
export { programmeInWindow, canScheduleProgramme };
import { normalizeName, programmeAiringKey } from '@shared/normalize.js';
import { resolveGuideChannel, guideNameIndex } from '@shared/epg-resolution.js';

export function findNowNext(programmes = [], at = new Date()) {
  if (!programmes || !programmes.length) return { now: null, next: null };
  const t = at.getTime();
  let now = null;
  let next = null;
  for (let i = 0; i < programmes.length; i++) {
    const p = programmes[i];
    const start = p.start ? new Date(p.start).getTime() : 0;
    const stop = p.stop ? new Date(p.stop).getTime() : 0;
    if (!p.timeUncertain && start <= t && t < stop) {
      now = p;
      const key = programmeAiringKey(p);
      // Old server/cache responses can still contain duplicates. Next starts
      // after this airing ends; conflicting overlaps remain in the guide.
      next = programmes.slice(i + 1).find((candidate) =>
        Date.parse(candidate.start) >= stop &&
        (key == null || programmeAiringKey(candidate) !== key)) || null;
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

// The alt-name tier, shared by every caller: it is one property of the loaded
// guide, not per-component state. Set once when the guide loads (see loadEpg),
// the same way api.js registers its unauthorized handler.
let sharedAltNames = {};

export function setAltNameIndex(index) {
  sharedAltNames = index && typeof index === 'object' ? index : {};
}

// Normalized display-name → channel id, or '' when no channel matches.
function channelIdByName(epg, name) {
  const target = normalizeName(name);
  return target ? guideNameIndex(epg).get(target) || '' : '';
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
  const key = resolveGuideChannel(epg, channel, overrides, altNames).matchedKey;
  const programmes = (key && epg.programmes?.[key]) || [];
  if (!programmes.length || !channel.tvgShift) return programmes;
  const shiftMs = channel.tvgShift * MS_PER_HOUR;
  const shifted = (iso) => (iso ? new Date(Date.parse(iso) + shiftMs).toISOString() : iso);
  return programmes.map((p) => ({ ...p, start: shifted(p.start), stop: shifted(p.stop) }));
}

export function fmtProgrammeTime(programme) {
  const range = `${fmtTime(programme.start)}–${programme.stop ? fmtTime(programme.stop) : 'End unknown'}`;
  return programme.timeUncertain ? `Approx. ${range}` : range;
}

// Calendar boundaries use the viewer's timezone, including 23/25-hour DST days.
// "Next 2 days" means today and tomorrow, rather than an assumed 48-hour day.
export function programmeSearchWindow(at = new Date(), days = 1) {
  const start = new Date(at); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + (days === 2 ? 2 : 1));
  return { from: start.getTime(), to: end.getTime() };
}

const searchText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const PROGRAMME_SEARCH_LIMIT = 200;

// Scan the already loaded guide without building a second catalogue. Retain only
// the earliest bounded results; total still describes every matching airing.
export function searchProgrammes(epg, channels, query, { at = new Date(), days = 1, overrides = {}, limit = PROGRAMME_SEARCH_LIMIT } = {}) {
  const words = searchText(query).trim().slice(0, 200).split(/\s+/).filter(Boolean);
  if (!epg || !words.length) return { results: [], total: 0 };
  limit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, PROGRAMME_SEARCH_LIMIT)) : PROGRAMME_SEARCH_LIMIT;
  const { from, to } = programmeSearchWindow(at, days);
  const results = []; let total = 0;
  const compare = (a, b) => Date.parse(a.programme.start) - Date.parse(b.programme.start) || a.channel.name.localeCompare(b.channel.name) || a.key.localeCompare(b.key);
  for (const channel of channels) {
    const seen = new Set();
    for (const programme of programmesForChannel(epg, channel, overrides)) {
      if (!programmeInWindow(programme, from, to)) continue;
      const text = searchText(`${programme.title || ''} ${programme.subTitle || ''}`);
      if (!words.every(word => text.includes(word))) continue;
      const airing = programmeAiringKey(programme) || JSON.stringify([programme.start, programme.stop, programme.title, programme.subTitle]);
      if (seen.has(airing)) continue;
      seen.add(airing); total++;
      const row = { channel, programme, key: JSON.stringify([channel.id, airing]) };
      if (results.length === limit && compare(row, results[limit - 1]) >= 0) continue;
      let low = 0, high = results.length;
      while (low < high) { const mid = (low + high) >>> 1; if (compare(results[mid], row) <= 0) low = mid + 1; else high = mid; }
      results.splice(low, 0, row);
      if (results.length > limit) results.pop();
    }
  }
  return { results, total };
}
