// Guide-matching helpers shared by the browser and the server.
//
// Resolving a channel to a guide entry — exact tvg-id first, then a normalized
// display-name match — has to give the same answer on both sides, or a guide's
// reported coverage would not be what the client actually resolves.

// Fold a channel name to a comparison key: lowercase, strip diacritics, drop
// quality suffixes (HD/FHD/UHD/4K/8K/SD) and all non-alphanumerics. So
// "Digi 24 HD", "Digi24" and "digi-24" all collapse to "digi24".
export function normalizeName(value) {
  return String(value || '')
    // Playlists annotate names with resolution and status — "Agro TV (360p)
    // [Not 24/7]" is the same channel a guide calls "Agro TV".
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\b(hd|fhd|uhd|4k|8k|sd)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The ids a channel's tvg-id could be keyed under. iptv-org ids carry an optional
 * feed suffix ("Digi24.ro@SD") that most guides drop, so the bare channel is
 * tried after the exact id — a guide that really does key on the feed still wins.
 */
export function channelIdCandidates(tvgId) {
  const id = String(tvgId || '').trim();
  if (!id) return [];
  const base = id.split('@')[0];
  return base && base !== id ? [id, base] : [id];
}

/**
 * Merge several parsed guides into one {channels, programmes}.
 * Shared: the browser merges the sources it fetched and the server merges the
 * ones it cached, and a channel must land in the same place either way.
 */
export function mergeGuides(guides) {
  const channels = {};
  const programmes = {};
  for (const guide of guides) {
    Object.assign(channels, guide.channels || {});
    for (const [id, list] of Object.entries(guide.programmes || {})) {
      programmes[id] = (programmes[id] || []).concat(list);
    }
  }
  for (const id of Object.keys(programmes)) {
    programmes[id].sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  return { channels, programmes };
}
