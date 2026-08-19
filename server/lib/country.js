// Country detection from M3U fields (no lookup tables, no network).
// Duplicated from client/src/lib/country.js (the server has no shared lib with
// the client) so the server-side channel index buckets channels into exactly the
// same countries the Live TV country grid shows. The presentation half
// (countryFlag / countryName) stays client-only.

// Some playlists use "uk" for the United Kingdom; ISO/emoji want "gb".
const ALIAS = { uk: 'gb', en: 'gb' };

// Two-letter tokens that look like country codes but aren't (quality/format tags).
const NOT_COUNTRIES = new Set(['hd', 'sd', 'fhd', 'uhd', 'tv', 'fm', 'am', '4k', '8k', 'ip', 'eu']);

const TVG_ID_RE = /\.([a-zA-Z]{2})(?:@|$)/;
// A leading 2-letter prefix delimited from the rest: "RO | News", "RO: X", "RO - Y".
const GROUP_PREFIX_RE = /^\s*([A-Za-z]{2})\s*[|:•∙\-]/;
// A regional-indicator flag pair anywhere in a string (🇷🇴, 🇬🇧, …).
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

// Normalize a raw 2-letter token to a country code, or '' if it's a non-country tag.
function normalizeCode(raw) {
  const cc = ALIAS[raw.toLowerCase()] || raw.toLowerCase();
  return NOT_COUNTRIES.has(cc) ? '' : cc;
}

// Country from a group-title prefix like "RO | Știri".
function countryFromGroup(group) {
  const m = (group || '').match(GROUP_PREFIX_RE);
  return m ? normalizeCode(m[1]) : '';
}

// Country from a flag emoji in the name: regional-indicator pair → letters (inverse of countryFlag).
function countryFromFlag(name) {
  const m = (name || '').match(FLAG_RE);
  if (!m) return '';
  const letters = [...m[0]].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65)).join('');
  return normalizeCode(letters);
}

// Resolve a channel's country: tvg-id suffix wins, then group-title prefix, then flag emoji.
export function channelCountry(ch) {
  const id = (ch && ch.tvgId) || '';
  const fromId = id.match(TVG_ID_RE);
  if (fromId) return fromId[1].toLowerCase();

  const fromGroup = countryFromGroup(ch && ch.group);
  if (fromGroup) return fromGroup;

  return countryFromFlag(ch && ch.name);
}

export default channelCountry;
