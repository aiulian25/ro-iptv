import { useMemo, useState, useEffect } from 'react';
import { useStore, selectFilteredChannels, selectCountries } from '../store/useStore';
import { countryFlag, countryName, channelCountry } from '../lib/country';
import CategoryChips from '../components/CategoryChips';
import RadioPlayer from '../components/RadioPlayer';
import ChannelLogo from '../components/ChannelLogo';
import FavouriteButton from '../components/FavouriteButton';
import Icon from '../components/Icon';

// Sentinel for the country <select>: '*' = every country, '' = the Undefined bucket.
const ALL_COUNTRIES = '*';

export default function RadioView() {
  const state = useStore();
  const playChannel = useStore((s) => s.playChannel);
  const currentChannel = useStore((s) => s.currentChannel);
  const stopPlayback = useStore((s) => s.stopPlayback);
  const [active, setActive] = useState(null);
  const [country, setCountry] = useState(ALL_COUNTRIES);

  const stations = useMemo(() => selectFilteredChannels(state, 'radio'), [state]);
  const countries = useMemo(() => selectCountries(state, 'radio'), [state.channels]);
  const visibleStations = useMemo(
    () => (country === ALL_COUNTRIES ? stations : stations.filter((s) => channelCountry(s) === country)),
    [stations, country]
  );

  // Keep a sensible default selected station.
  useEffect(() => {
    if (!active && visibleStations.length) {
      const fromCurrent = currentChannel?.kind === 'radio' ? currentChannel : null;
      setActive(fromCurrent || visibleStations[0]);
    }
  }, [visibleStations, active, currentChannel]);

  const select = (s) => {
    setActive(s);
    playChannel(s);
  };

  const idx = visibleStations.findIndex((s) => s.id === active?.id);
  const prev = () => idx > 0 && select(visibleStations[idx - 1]);
  const nextStation = () => idx < visibleStations.length - 1 && select(visibleStations[idx + 1]);

  return (
    <div className="md:ml-20 pt-24 md:pt-28 px-4 md:px-8 pb-8 min-h-screen flex flex-col lg:flex-row gap-6">
      <section className="flex-1 min-w-0">
        <div className="mb-5">
          <h1 className="text-2xl md:text-3xl font-semibold">Live Radio Stations</h1>
          <p className="text-on-surface-variant">
            {visibleStations.length} stations • ultra-HD audio from around the globe.
          </p>
          <label className="sr-only" htmlFor="radio-country">Filter stations by country</label>
          <select
            id="radio-country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="glass rounded-xl px-4 py-3 outline-none mt-3 w-full sm:w-auto max-w-full"
          >
            <option value={ALL_COUNTRIES}>🌐 All countries</option>
            {countries.map(([code, count]) => (
              <option key={code || 'undef'} value={code}>
                {countryFlag(code)} {countryName(code)} ({count})
              </option>
            ))}
          </select>
        </div>
        <div className="mb-4">
          <CategoryChips kind="radio" />
        </div>

        {visibleStations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-on-surface-variant gap-3">
            <Icon name="radio" className="text-6xl opacity-60" />
            <p>No radio stations found in this playlist.</p>
            <p className="text-sm">Stations are detected from <code>group-title="Radio"</code> or audio URLs.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 max-h-[calc(100vh-260px)] overflow-y-auto scroll-area pr-1">
            {visibleStations.map((s) => {
              const isActive = active?.id === s.id;
              return (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => select(s)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      select(s);
                    }
                  }}
                  className={`relative glass rounded-3xl p-5 flex items-start gap-4 text-left cursor-pointer transition-all duration-300 hover:scale-[1.03] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                    isActive ? 'border-primary/60 bg-primary/10' : ''
                  }`}
                >
                  <FavouriteButton channelId={s.id} className="absolute top-3 right-3" />
                  <ChannelLogo src={s.logo} kind="radio" rounded="rounded-2xl" className="w-24 h-24" />
                  <div className="min-w-0 pr-6">
                    <span
                      className={`font-mono text-[11px] uppercase tracking-widest ${
                        isActive ? 'text-primary' : 'text-on-surface-variant'
                      }`}
                    >
                      {isActive ? 'Live Now' : s.group}
                    </span>
                    <h3 className="text-lg font-semibold leading-tight truncate">{s.name}</h3>
                    <p className="text-on-surface-variant text-sm truncate">{s.group}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="w-full lg:w-[450px] shrink-0 h-[70vh] lg:h-[calc(100vh-160px)]">
        <RadioPlayer station={active} onPrev={prev} onNext={nextStation} onStop={stopPlayback} />
      </section>
    </div>
  );
}
