// Known public XMLTV guide providers, as data.
//
// Settings used to require the user to find a guide URL somewhere and paste it
// in, then discover later whether it covered any of their channels. This is the
// lookup that turns "the countries you actually have" into candidate guides.
//
// Adding a provider is one entry here and nothing else: `countries` is 'all' when
// it publishes a pack per country code, or the list of codes it really covers.
// `codeAliases` carries the spellings a provider uses that differ from ISO —
// `urlFor` receives the provider's own code, already uppercased and validated.

// Guards the interpolation below: a country code comes from playlist metadata,
// so it is treated as untrusted even though channelCountry() already shapes it.
const COUNTRY_CODE_RE = /^[a-z]{2}$/;

export const EPG_SOURCE_REGISTRY = [
  {
    id: 'epgshare01',
    name: 'EPGSHARE01',
    countries: 'all',
    // Publishes the UK pack as UK; the app's canonical code for it is the ISO gb
    // (client/src/lib/country.js maps uk -> gb), so epg_ripper_GB1 does not exist.
    codeAliases: { gb: 'UK' },
    urlFor: (providerCode) => `https://epgshare01.online/epgshare01/epg_ripper_${providerCode}1.xml.gz`,
    notes: 'Per-country packs, refreshed daily. Not every country has one.',
  },
  {
    id: 'freeview-epg',
    name: 'Freeview EPG',
    countries: ['gb'],
    urlFor: () => 'https://raw.githubusercontent.com/dp247/Freeview-EPG/master/epg.xml',
    notes: 'UK free-to-air television and radio stations.',
  },
  // Further providers go here. epg.pw and open-epg also publish per-country
  // guides, but their URL shapes differ per site and per country — add each as
  // one entry once its pattern is confirmed, no other file changes.
];

/**
 * Candidate guides for a set of country codes, in registry order per country.
 * @returns {Array<{id: string, name: string, country: string, url: string, notes: string}>}
 */
export function suggestionsForCountries(countries = []) {
  const suggestions = [];
  for (const countryCode of countries) {
    if (!COUNTRY_CODE_RE.test(countryCode)) continue;
    for (const source of EPG_SOURCE_REGISTRY) {
      const covered = source.countries === 'all' || source.countries.includes(countryCode);
      if (!covered) continue;
      const providerCode = source.codeAliases?.[countryCode] || countryCode.toUpperCase();
      suggestions.push({
        id: source.id,
        name: source.name,
        country: countryCode,
        url: source.urlFor(providerCode),
        notes: source.notes,
      });
    }
  }
  return suggestions;
}
