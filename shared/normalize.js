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

// Programme titles deliberately keep punctuation, accents and edition/quality
// annotations: channel-name normalization would collapse distinct shows.
export function programmeAiringKey(programme) {
  const title = String(programme.title || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const start = Date.parse(programme.start);
  const stop = programme.stop == null ? null : Date.parse(programme.stop);
  if (!title || !Number.isFinite(start) || (stop !== null && (!Number.isFinite(stop) || stop <= start))) return null;
  // Coarse timestamps must not swallow a precise airing at the same lower bound.
  const precision = programme.timeUncertain ? [programme.startPrecision, programme.stopPrecision] : null;
  return JSON.stringify([start, stop, title, precision]);
}

const emptyMetadata = (value) => value == null || (typeof value === 'string' && !value.trim()) ||
  (Array.isArray(value) && value.length === 0);

/**
 * Exact airings merge only within the same guide channel. Configured source
 * order wins nonempty programme-field conflicts; later sources fill gaps.
 * Different titles/intervals stay inspectable, even when they overlap.
 */
export function mergeGuides(guides) {
  const channels = {};
  const programmes = {};
  const indexes = new Map();
  for (const guide of guides) {
    for (const [id, value] of Object.entries(guide.channels || {})) Object.defineProperty(channels, id, { value, enumerable: true, writable: true, configurable: true });
    for (const [id, list] of Object.entries(guide.programmes || {})) {
      if (!indexes.has(id)) { indexes.set(id, new Map()); Object.defineProperty(programmes, id, { value: [], enumerable: true, writable: true, configurable: true }); }
      const index = indexes.get(id);
      for (const programme of list) {
        const key = programmeAiringKey(programme);
        const existing = key == null ? null : index.get(key);
        if (existing) {
          for (const [field, value] of Object.entries(programme)) {
            if (emptyMetadata(existing[field]) && !emptyMetadata(value)) existing[field] = value;
          }
        } else {
          const copy = { ...programme };
          programmes[id].push(copy);
          if (key != null) index.set(key, copy);
        }
      }
    }
  }
  for (const id of Object.keys(programmes)) {
    programmes[id].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }
  return { channels, programmes };
}
