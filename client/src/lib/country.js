// Presentation helpers for the country a channel belongs to. The detection half
// (channelCountry) is shared with the server — see shared/country.js.
import { ALIAS } from '@shared/country.js';

// A channel's categories — group-title may be ";"-joined (e.g. "Animation;Kids;Music").
export function channelCategories(ch) {
  return ((ch && ch.group) || 'Uncategorized')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Flag emoji from a 2-letter code via regional-indicator symbols.
export function countryFlag(code) {
  if (!code) return '🌐';
  const cc = (ALIAS[code.toLowerCase()] || code).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let regionNames;
// Human-readable country name from a code (uses the platform's Intl data).
export function countryName(code) {
  if (!code) return 'Undefined';
  const cc = (ALIAS[code.toLowerCase()] || code).toUpperCase();
  try {
    regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(cc) || cc;
  } catch {
    return cc;
  }
}
