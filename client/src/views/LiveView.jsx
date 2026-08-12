import { useMemo, useState } from 'react';
import { useStore, selectFilteredChannels } from '../store/useStore';
import ChannelList from '../components/ChannelList';
import CategoryChips from '../components/CategoryChips';
import CategoryGrid from '../components/CategoryGrid';
import CatchupPanel from '../components/CatchupPanel';
import CountryGrid from '../components/CountryGrid';
import MobilePanelBar from '../components/MobilePanelBar';
import EpgGuide from '../components/EpgGuide';
import EpgLinkButton from '../components/EpgLinkButton';
import ProgrammeModal from '../components/ProgrammeModal';
import VideoPlayer from '../components/VideoPlayer';
import Icon from '../components/Icon';
import FavouriteButton from '../components/FavouriteButton';
import { countryFlag, countryName } from '../lib/country';
import { programmesForChannel, findNowNext, fmtTime, progressPct } from '../lib/epg';
import { supportsCatchup } from '../lib/catchup';

const PANEL_TITLES = {
  channels: 'Channels',
  favourites: 'Favourites',
  history: 'Recently Watched',
  epg: 'EPG Guide',
  categories: 'Categories',
  catchup: 'Catchup',
};

// Fixed manual-record durations [label, minutes]. The server clamps to RECORDING_MAX_MINUTES.
const RECORD_DURATION_OPTIONS = [
  ['30 min', 30],
  ['1 hour', 60],
  ['2 hours', 120],
  ['Max (3 hours)', 180],
];
const MS_PER_MINUTE = 60000;

export default function LiveView() {
  const state = useStore();
  const { sidebarPanel, currentChannel, channels, epg, history, recordings, selectedCountry } = state;
  const playChannel = useStore((s) => s.playChannel);
  const startRecording = useStore((s) => s.startRecording);
  const stopRecording = useStore((s) => s.stopRecording);
  const stopPlayback = useStore((s) => s.stopPlayback);
  const setSelectedCountry = useStore((s) => s.setSelectedCountry);
  const setCategory = useStore((s) => s.setCategory);
  const setSidebarPanel = useStore((s) => s.setSidebarPanel);
  const [showRecordMenu, setShowRecordMenu] = useState(false);
  const [selectedProgramme, setSelectedProgramme] = useState(null);

  // Sort by tvg-chno only when every channel in view has one; a mixed list keeps playlist order.
  const liveChannels = useMemo(() => {
    const list = selectFilteredChannels(state, 'live');
    const allNumbered = list.length > 0 && list.every((c) => c.chno != null);
    return allNumbered ? [...list].sort((a, b) => a.chno - b.chno) : list;
  }, [state]);

  // Prev/next within the current filtered list — drives OS prev/next controls.
  const playRelative = (dir) => {
    if (!liveChannels.length) return;
    let idx = currentChannel ? liveChannels.findIndex((c) => c.id === currentChannel.id) : -1;
    if (idx < 0) idx = dir > 0 ? -1 : 0;
    playChannel(liveChannels[(idx + dir + liveChannels.length) % liveChannels.length]);
  };

  // Country browser (mockup screen 1) vs a selected country's channels (screen 2).
  // An active search on the country browser swaps the grid for cross-country results.
  const searching = state.search.trim().length > 0;
  const showGrid = sidebarPanel === 'channels' && selectedCountry === null && !searching;
  const isGlobalSearch = sidebarPanel === 'channels' && selectedCountry === null && searching;
  const isCountryChannels = sidebarPanel === 'channels' && selectedCountry !== null;

  // Active "recording now" entry for the current channel (matched by id or url).
  const activeRec =
    currentChannel &&
    recordings.find(
      (r) => r.status === 'recording' && (r.channelId === currentChannel.id || r.url === currentChannel.url)
    );
  const isRecording = !!activeRec;

  // History panel maps stored entries back to channel-like objects.
  const historyChannels = useMemo(
    () => history.map((h) => ({ ...h, group: h.group || 'History' })),
    [history]
  );

  const epgOverrides = state.settings.epgOverrides || {};
  const progs = currentChannel ? programmesForChannel(epg, currentChannel, epgOverrides) : [];
  const { now, next } = findNowNext(progs);

  // Record-duration menu options: "Until programme ends" (when EPG now exists) + fixed durations.
  const untilEnds = now ? Math.max(1, Math.ceil((new Date(now.stop) - Date.now()) / MS_PER_MINUTE)) : 0;
  const recordOptions = now
    ? [['Until programme ends', untilEnds], ...RECORD_DURATION_OPTIONS]
    : RECORD_DURATION_OPTIONS;

  // Category cards are built from the country-scoped list WITHOUT the category
  // filter, so counts don't collapse to the active category.
  const categoryBase = useMemo(
    () => selectFilteredChannels({ ...state, activeCategory: 'All' }, 'live'),
    [state]
  );

  let leftContent;
  if (sidebarPanel === 'epg') {
    leftContent = <EpgGuide channels={liveChannels} onSelect={playChannel} />;
  } else if (sidebarPanel === 'history') {
    leftContent = <ChannelList channels={historyChannels} onSelect={playChannel} />;
  } else if (sidebarPanel === 'categories') {
    leftContent = (
      <CategoryGrid
        channels={categoryBase}
        onSelect={(category) => {
          setCategory(category);
          setSidebarPanel('channels');
        }}
      />
    );
  } else if (sidebarPanel === 'catchup') {
    leftContent = <CatchupPanel channels={liveChannels} epg={epg} />;
  } else {
    leftContent = <ChannelList channels={liveChannels} onSelect={playChannel} />;
  }

  const isCatchup = !!currentChannel?.isCatchup;

  const listCount = sidebarPanel === 'history' ? historyChannels.length : liveChannels.length;

  let panelSubline = `Live Now • ${listCount} Channels`;
  if (isGlobalSearch) panelSubline = `${listCount} matches for “${state.search.trim()}”`;
  if (sidebarPanel === 'categories') panelSubline = 'Pick a category';
  if (sidebarPanel === 'catchup') panelSubline = `${liveChannels.filter(supportsCatchup).length} archive channels`;

  // Mockup screen 1 — full-width country browser.
  if (showGrid) {
    return (
      <div className="md:ml-20 pt-24 md:pt-28 px-4 md:px-8 pb-8 min-h-screen flex flex-col gap-3">
        <MobilePanelBar />
        <CountryGrid onSelect={setSelectedCountry} />
      </div>
    );
  }

  return (
    <div className="md:ml-20 pt-24 md:pt-28 px-4 md:px-8 pb-8 min-h-screen">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: list — on mobile it stacks BELOW the player (order-3) */}
        <div className="order-3 lg:order-none lg:col-span-5 xl:col-span-4 flex flex-col gap-3">
          <MobilePanelBar />
          {isCountryChannels ? (
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setSelectedCountry(null)}
                className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface w-max"
              >
                <Icon name="arrow_back" /> <span className="text-sm">All Countries</span>
              </button>
              <div className="flex items-center gap-3">
                <span className="text-3xl leading-none">{countryFlag(selectedCountry)}</span>
                <div>
                  <h2 className="text-2xl font-semibold text-primary leading-tight">{countryName(selectedCountry)}</h2>
                  <p className="text-on-surface-variant text-sm">Live Now • {listCount} Channels</p>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <h2 className="text-2xl font-semibold text-primary">
                {isGlobalSearch ? 'Results' : PANEL_TITLES[sidebarPanel] || 'Channels'}
              </h2>
              <p className="text-on-surface-variant text-sm break-words">{panelSubline}</p>
            </div>
          )}
          {sidebarPanel === 'channels' && <CategoryChips kind="live" />}
          {/* Desktop: independent scrolling column. Mobile: flows in the page so
              the player stays at the top and the whole page scrolls as one. */}
          <div className="scroll-area pr-1 lg:overflow-y-auto lg:max-h-[calc(100vh-220px)]">{leftContent}</div>
        </div>

        {/* Right: player + metadata. On mobile the column uses display:contents so
            the video & metadata become direct grid children — this lets the video
            stay STICKY across the whole page (over the scrolling list). */}
        <div className="contents lg:flex lg:flex-col lg:gap-5 lg:order-none lg:col-span-7 xl:col-span-8">
          {/* Video — pinned at the top on mobile while the list scrolls under it */}
          <div className="order-1 lg:order-none sticky top-24 z-30 lg:static w-full aspect-video">
            {currentChannel ? (
              <VideoPlayer
                channel={currentChannel}
                onPrev={() => playRelative(-1)}
                onNext={() => playRelative(1)}
                onStop={stopPlayback}
              />
            ) : (
              <div className="w-full h-full rounded-3xl glass flex flex-col items-center justify-center text-on-surface-variant gap-3">
                <Icon name="smart_display" className="text-6xl text-primary/60" />
                <p>Select a channel to start watching</p>
              </div>
            )}
          </div>

          {currentChannel && (
            <div className="order-2 lg:order-none glass-dark p-5 md:p-7 rounded-3xl flex flex-col gap-5">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <Icon name={isCatchup ? 'replay' : 'live_tv'} fill className="text-primary text-3xl" />
                  <div>
                    <h1 className="text-2xl md:text-3xl font-semibold">
                      {isCatchup ? currentChannel.catchupTitle : now?.title || currentChannel.name}
                    </h1>
                    <p className="text-on-surface-variant text-sm">{currentChannel.name} • {currentChannel.group}</p>
                  </div>
                </div>
                <div className="flex gap-3 flex-wrap">
                  <FavouriteButton channelId={currentChannel.id} variant="pill" />
                  {!isCatchup && progs.length === 0 && <EpgLinkButton channel={currentChannel} />}
                  {!isCatchup &&
                    (isRecording ? (
                      <button
                        onClick={() => stopRecording(activeRec.id)}
                        className="px-5 py-2.5 rounded-full flex items-center gap-2 transition-all bg-red-500/20 border border-red-500 text-red-300 hover:bg-red-500/30"
                      >
                        <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                        <span className="font-mono text-xs">Stop Recording</span>
                      </button>
                    ) : (
                      <div className="relative">
                        <button
                          onClick={() => setShowRecordMenu((s) => !s)}
                          aria-haspopup="true"
                          aria-expanded={showRecordMenu}
                          className="px-5 py-2.5 rounded-full flex items-center gap-2 transition-all glass hover:bg-white/10"
                        >
                          <Icon name="fiber_manual_record" className="text-error" />
                          <span className="font-mono text-xs">Record</span>
                        </button>
                        {showRecordMenu && (
                          <div className="absolute top-12 right-0 z-40 glass-dark rounded-lg p-1 min-w-[180px]">
                            {recordOptions.map(([label, mins]) => (
                              <button
                                key={label}
                                onClick={() => {
                                  startRecording(currentChannel, now, mins);
                                  setShowRecordMenu(false);
                                }}
                                className="block w-full text-left px-3 py-1.5 rounded text-sm hover:bg-white/10"
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>

              {isCatchup && (
                <span className="w-max font-mono text-xs uppercase text-primary glass rounded-full px-4 py-1.5">
                  Catchup
                </span>
              )}

              {!isCatchup && now?.desc && (
                <p
                  onClick={() => setSelectedProgramme(now)}
                  className="text-on-surface-variant max-w-3xl cursor-pointer hover:text-on-surface transition-colors"
                >
                  {now.desc}
                </p>
              )}

              {!isCatchup && now && (
                <div className="flex flex-col gap-3">
                  <div className="flex justify-between items-end flex-wrap gap-2">
                    <div className="flex flex-col">
                      <span className="font-mono text-xs text-primary uppercase">Now Playing</span>
                      <span className="font-semibold">
                        {fmtTime(now.start)} – {fmtTime(now.stop)}
                      </span>
                    </div>
                    {next && (
                      <div className="text-right">
                        <span className="font-mono text-xs text-on-surface-variant uppercase">Next</span>
                        <p>{next.title} • {fmtTime(next.start)}</p>
                      </div>
                    )}
                  </div>
                  <div className="w-full h-2 bg-surface-variant/50 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary shadow-[0_0_15px_rgba(192,193,255,0.6)]"
                      style={{ width: `${progressPct(now)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ProgrammeModal programme={selectedProgramme} onClose={() => setSelectedProgramme(null)} />
    </div>
  );
}
