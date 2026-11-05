// Versioned playlist-scoped identity. Hashes are identifiers, not encryption.
export const CHANNEL_IDENTITY_VERSION = 3;
export function identityHash(value) {
  let a = 0x811c9dc5,
    b = 0x9e3779b9,
    c = 0x85ebca6b,
    d = 0xc2b2ae35;
  for (const ch of String(value)) {
    const n = ch.codePointAt(0);
    a = Math.imul(a ^ n, 16777619);
    b = Math.imul(b ^ n, 2246822507);
    c = Math.imul(c ^ n, 3266489909);
    d = Math.imul(d ^ n, 668265263);
  }
  return [a, b, c, d].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
const AUTH_QUERY = /^(?:token|access_token|auth|authorization|password|pass|username|user|expires?|expiry|signature|sig|key|api_key|session|sessionid)$/i;
export function channelRoute(channel) {
  try {
    const url = new URL(channel.url);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (AUTH_QUERY.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString();
  } catch {
    return String(channel.url || '');
  }
}
const normalized = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
function facts(channel) {
  const guide = String(channel.tvgId || '').trim();
  const quality = [...new Set(`${channel.name || ''} ${channel.tvgName || ''} ${channel.group || ''}`.toUpperCase().match(/\b(?:UHD|4K|FHD|HD|SD|HEVC|H264|H265)\b/g) || [])].sort().join(',');
  const number = Number.isFinite(channel.chno) && channel.chno !== null ? String(channel.chno) : '';
  return {
    guide,
    route: channel.identityRouteKey || identityHash(channelRoute(channel)),
    guideNumber: guide && number ? `${guide}|${number}` : '',
    variant: guide && (quality || number) ? `${guide}|${quality || 'number:' + number}` : '',
    context: number ? `${number}|${normalized(channel.tvgName || channel.name)}` : ''
  };
}
export function channelIdentitySnapshot(channel) {
  return {
    id: channel.id,
    tvgId: channel.tvgId || '',
    name: channel.name || '',
    tvgName: channel.tvgName || '',
    group: channel.group || '',
    chno: channel.chno ?? null,
    identityAmbiguous: !!channel.identityAmbiguous,
    identityRouteKey: facts(channel).route
  };
}
function counts(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const v = row[key];
    if (v) map.set(v, (map.get(v) || 0) + 1);
  }
  return map;
}
export function assignChannelIdentities(channels) {
  const rows = channels.map(facts),
    guides = counts(rows, 'guide'),
    variants = counts(rows, 'variant');
  const keys = rows.map(row => row.guide && guides.get(row.guide) === 1 ? 'guide:' + row.guide : row.variant && variants.get(row.variant) === 1 ? 'variant:' + row.variant : 'route:' + row.route);
  const frequencies = new Map();
  for (const key of keys) frequencies.set(key, (frequencies.get(key) || 0) + 1);
  const seen = new Map();
  return channels.map((channel, i) => {
    const ambiguous = frequencies.get(keys[i]) > 1;
    let id = 'c3-' + identityHash(keys[i] + (ambiguous ? '|ambiguous:' + channel.url + '|' + channel.name : ''));
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id += '-' + (n + 1);
    return {
      ...channel,
      id,
      identityVersion: 3,
      ...(ambiguous ? {
        identityAmbiguous: true
      } : {})
    };
  });
}
// Match only unique evidence on BOTH sides. Name alone is never evidence.
export function channelIdentityMatches(previous, next) {
  const old = previous.map(facts),
    fresh = next.map(facts),
    used = new Set(),
    matched = new Map();
  for (const key of ['guide', 'variant', 'guideNumber', 'route', 'context']) {
    const before = counts(old, key),
      after = counts(fresh, key),
      lookup = new Map(old.map((row, i) => [row[key], i]));
    for (let n = 0; n < fresh.length; n++) {
      if (matched.has(n) || !fresh[n][key] || after.get(fresh[n][key]) !== 1 || before.get(fresh[n][key]) !== 1) continue;
      const p = lookup.get(fresh[n][key]);
      if (used.has(p) || previous[p].identityAmbiguous || next[n].identityAmbiguous) continue;
      if (key !== 'guide' && old[p].guide && fresh[n].guide && old[p].guide !== fresh[n].guide) continue;
      used.add(p);
      matched.set(n, p);
    }
  }
  return matched;
}
export function channelAliases(previous, next) {
  const aliases = {};
  for (const [n, p] of channelIdentityMatches(previous, next)) if (previous[p].id !== next[n].id) aliases[previous[p].id] = next[n].id;
  return aliases;
}
export function reconcileChannelIdentities(previous, raw) {
  const fresh = assignChannelIdentities(raw),
    matches = channelIdentityMatches(previous, fresh),
    aliases = {};
  const channels = fresh.map((channel, n) => {
    const old = previous[matches.get(n)];
    const id = old?.id?.startsWith('c3-') ? old.id : channel.id;
    if (old && old.id !== id) aliases[old.id] = id;
    if (channel.id !== id) aliases[channel.id] = id;
    return {
      ...channel,
      id
    };
  });
  // Ambiguous or unmatched variants stay separate; no automatic alias is made.
  const previousGuides = new Set(previous.map(channel => channel.tvgId).filter(Boolean));
  const weakNames = new Set(previous.map(channel => normalized(channel.tvgName || channel.name)));
  const weakNumbers = new Set(previous.map(channel => channel.chno).filter(value => value !== null && value !== undefined));
  const conflicts = channels.filter((channel, n) => channel.identityAmbiguous || !matches.has(n) && (previousGuides.has(channel.tvgId) || weakNames.has(normalized(channel.tvgName || channel.name)) || weakNumbers.has(channel.chno))).map(channel => ({
    id: channel.id,
    name: channel.name,
    reason: channel.identityAmbiguous ? 'ambiguous-variant' : 'unmatched-variant'
  }));
  return {
    version: 3,
    channels,
    aliases,
    conflicts
  };
}
export function remapReferences(value, key, aliases, channels) {
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  const resolve = id => {
    let current = id;
    const seen = new Set();
    while (aliases[current] && !seen.has(current)) {
      seen.add(current);
      current = aliases[current];
    }
    return current;
  };
  if (key === 'favourites') return [...new Set((Array.isArray(value) ? value : []).map(resolve))];
  if (key === 'history') {
    const byKey = new Map();
    for (const old of Array.isArray(value) ? value : []) {
      const id = resolve(old.id),
        fresh = byId.get(id);
      const row = {
        ...old,
        ...(fresh || {}),
        id,
        at: old.at
      };
      if (!byKey.has(id) || (byKey.get(id).at || 0) < (row.at || 0)) byKey.set(id, row);
    }
    return [...byKey.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  }
  if (key === 'settings' && value && typeof value === 'object') {
    const overrides = {
      ...(value.epgOverrides || {})
    };
    for (const [id, target] of Object.entries(overrides)) {
      const mapped = resolve(id);
      if (mapped !== id && (!Object.hasOwn(overrides, mapped) || overrides[mapped] === target)) {
        overrides[mapped] = target;
        delete overrides[id];
      }
    }
    return {
      ...value,
      ...(value.epgOverrides ? {
        epgOverrides: overrides
      } : {})
    };
  }
  return value;
}
