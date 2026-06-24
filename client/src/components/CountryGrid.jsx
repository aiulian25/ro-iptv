import { useMemo, useState } from 'react';
import { useStore, selectCountries } from '../store/useStore';
import { countryFlag, countryName } from '../lib/country';
import Icon from './Icon';

// Mockup screen 1: browse Live TV by country.
export default function CountryGrid({ onSelect }) {
  const state = useStore();
  const [query, setQuery] = useState('');

  const countries = useMemo(() => selectCountries(state, 'live'), [state]);
  const total = useMemo(() => countries.reduce((n, [, c]) => n + c, 0), [countries]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter(([code]) => countryName(code).toLowerCase().includes(q) || code.includes(q));
  }, [countries, query]);

  return (
    <div className="flex flex-col gap-5 h-[calc(100vh-160px)]">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">Browse by Country</h1>
          <p className="text-on-surface-variant">
            Live Now • {total.toLocaleString()} Channels across {countries.length} countries
          </p>
        </div>
        <div className="glass px-4 py-2.5 rounded-full flex items-center gap-2 w-full sm:w-72">
          <Icon name="search" className="text-primary text-xl" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search countries…"
            className="bg-transparent outline-none border-none text-sm w-full text-on-surface placeholder:text-on-surface-variant/60"
            aria-label="Search countries"
          />
        </div>
      </div>

      {countries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-on-surface-variant gap-3 text-center">
          <Icon name="public_off" className="text-6xl opacity-60" />
          <p>No channels to browse yet — add a playlist in Settings.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 overflow-y-auto scroll-area pr-1 pb-2">
          {filtered.map(([code, count]) => (
            <button
              key={code || 'undef'}
              onClick={() => onSelect(code)}
              className="glass rounded-2xl p-5 flex items-center gap-4 text-left transition-all duration-300 hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className="text-4xl leading-none shrink-0">{countryFlag(code)}</span>
              <div className="flex-1 min-w-0">
                <h3 className="text-lg font-semibold truncate">{countryName(code)}</h3>
                <p className="text-sm text-on-surface-variant">{count.toLocaleString()} channels</p>
              </div>
              <Icon name="chevron_right" className="text-on-surface-variant" />
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-on-surface-variant text-sm col-span-full py-8 text-center">No countries match “{query}”.</p>
          )}
        </div>
      )}
    </div>
  );
}
