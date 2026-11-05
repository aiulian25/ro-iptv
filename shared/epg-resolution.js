import { normalizeName, channelIdCandidates } from './normalize.js';

const nameIndexes = new WeakMap();
export function guideNameIndex(guide) {
  let index = nameIndexes.get(guide);
  if (index) return index;
  index = new Map();
  for (const [id, value] of Object.entries(guide.channels || {})) {
    const name = normalizeName(typeof value === 'string' ? value : value?.name);
    if (name && !index.has(name)) index.set(name, id);
  }
  nameIndexes.set(guide, index);
  return index;
}

// A known guide channel and a channel with schedule entries are different facts.
// An explicit link is authoritative even when its target has disappeared: report
// it as missing and never fall through to an automatic replacement.
export function resolveGuideChannel(guide, channel, overrides = {}, altNames = {}) {
  const known = (id) => !!id && (Object.hasOwn(guide.channels || {}, id) ||
    Array.isArray((guide.programmes || {})[id]));
  const result = (targetKey, method) => {
    const exists = known(targetKey);
    const list = (guide.programmes || {})[targetKey];
    const hasProgrammes = exists && Array.isArray(list) && list.length > 0;
    return { targetKey, matchedKey: exists ? targetKey : null, method,
      hasProgrammes, status: !exists ? (method === 'override' ? 'missing-target' : 'unmatched')
        : hasProgrammes ? 'scheduled' : Array.isArray(list) ? 'empty-schedule' : 'metadata-only' };
  };
  const override = overrides[channel.id];
  if (override) return result(override, 'override');
  const byId = channelIdCandidates(channel.tvgId).find(known);
  if (byId) return result(byId, 'tvgId');
  const normalized = normalizeName(channel.tvgName || channel.name);
  const byName = guideNameIndex(guide).get(normalized);
  if (known(byName)) return result(byName, 'name');
  const byAltName = altNames[normalized];
  if (known(byAltName)) return result(byAltName, 'altName');
  return result(null, null);
}
