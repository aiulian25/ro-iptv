// How much of the user's channel set a guide actually covers.
//
// Exact tvg-id first, then a normalized display-name match — the same resolution
// the browser performs, because both sides use shared/normalize.js.

import { normalizeName, channelIdCandidates } from '../../shared/normalize.js';

// An epg.channels value is {name, icon}; older cached shapes were a bare string.
function channelDisplayName(value) {
  return typeof value === 'string' ? value : value?.name || '';
}

/**
 * Which of `channels` the guide covers.
 * @param {{channels: object, programmes: object}} guide parsed XMLTV
 * @param {Array<{tvgId: string, name: string, tvgName: string}>} channels wanted channels
 * @returns {{matched: number, total: number, unmatched: string[]}}
 */
export function matchGuideToChannels(guide, channels) {
  const results = matchAll(channels, guide);
  const unmatched = results.filter((result) => !result.matchedKey).map((result) => result.name);
  return { matched: results.length - unmatched.length, total: channels.length, unmatched };
}

// Normalized display name -> guide channel id, built once per guide.
function guideNameToId(guide) {
  const index = new Map();
  for (const [id, value] of Object.entries(guide.channels || {})) {
    const key = normalizeName(channelDisplayName(value));
    if (key && !index.has(key)) index.set(key, id);
  }
  return index;
}

/**
 * Build the alt-name tier: normalized name → the guide id it belongs to.
 * iptv-org lists a channel's alternative names; where one of those matches a
 * playlist's wording, the channel can be resolved even though its own display
 * name does not. Only names the guide actually carries are included, so the map
 * stays small and every entry can produce a real match.
 * @param {{byCountryName: Map}} dataset the iptv-org index (F4), or null
 * @param {{channels: object, programmes: object}} guide
 * @returns {Record<string, string>}
 */
export function buildAltNameIndex(dataset, guide) {
  if (!dataset) return {};
  const guideIds = new Set([...Object.keys(guide.channels || {}), ...Object.keys(guide.programmes || {})]);
  const guideNames = guideNameToId(guide);
  const altNames = {};
  for (const names of dataset.byCountryName.values()) {
    for (const [normalized, channel] of names) {
      if (!guideIds.has(channel.id)) continue;
      if (guideNames.has(normalized)) continue; // the plain-name tier already covers it
      if (!altNames[normalized]) altNames[normalized] = channel.id;
    }
  }
  return altNames;
}

/**
 * Resolve every wanted channel against the guide, reporting HOW each matched so
 * the coverage view can explain itself. Tiers, in order: a manual override, an
 * exact tvg-id, a normalized display name, then an iptv-org alternative name.
 * @returns {Array<{channelId, name, tvgId, country, playlistId, matchedKey, method}>}
 */
export function matchAll(wantedChannels, guide, overrides = {}, altNames = {}) {
  const guideChannels = guide.channels || {};
  const guideProgrammes = guide.programmes || {};
  const guideNames = guideNameToId(guide);

  return wantedChannels.map((channel) => {
    const base = {
      channelId: channel.id,
      name: channel.name,
      tvgId: channel.tvgId || '',
      country: channel.country || '',
      playlistId: channel.playlistId || '',
    };
    const override = overrides[channel.id];
    if (override) return { ...base, matchedKey: override, method: 'override' };
    const byId = channelIdCandidates(channel.tvgId).find(
      (candidate) => guideChannels[candidate] || guideProgrammes[candidate]
    );
    if (byId) return { ...base, matchedKey: byId, method: 'tvgId' };
    const normalized = normalizeName(channel.tvgName || channel.name);
    const byName = guideNames.get(normalized);
    if (byName) return { ...base, matchedKey: byName, method: 'name' };
    const byAltName = altNames[normalized];
    if (byAltName) return { ...base, matchedKey: byAltName, method: 'altName' };
    return { ...base, matchedKey: null, method: null };
  });
}
