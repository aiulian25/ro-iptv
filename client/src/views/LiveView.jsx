import { useMemo } from 'react';
import { useStore, selectFilteredChannels } from '../store/useStore';
import ChannelList from '../components/ChannelList';
import CategoryChips from '../components/CategoryChips';
import CountryGrid from '../components/CountryGrid';
import EpgGuide from '../components/EpgGuide';
import VideoPlayer from '../components/VideoPlayer';
import Icon from '../components/Icon';
import FavouriteButton from '../components/FavouriteButton';
import { countryFlag, countryName } from '../lib/country';
import { programmesForChannel, findNowNext, fmtTime, progressPct } from '../lib/epg';

const PANEL_TITLES = {
  channels: 'Channels',
  favourites: 'Favourites',
  history: 'Recently Watched',
  epg: 'EPG Guide',
  categories: 'Categories',
  catchup: 'Catchup',
};

export default function LiveView() {
  const state = useStore();
  const { sidebarPanel, currentChannel, channels, epg, history, recordings, selectedCountry } = state;
  const playChannel = useStore((s) => s.playChannel);
  const startRecording = useStore((s) => s.startRecording);
  const stopRecording = useStore((s) => s.stopRecording);
  const stopPlayback = useStore((s) => s.stopPlayback);
  const setSelectedCountry = useStore((s) => s.setSelectedCountry);

  const liveChannels = useMemo(() => selectFilteredChannels(state, 'live'), [state]);

  // Prev/next within the current filtered list — drives OS prev/next controls.
  const playRelative = (dir) => {
    if (!liveChannels.length) return;
    let idx = currentChannel ? liveChannels.findIndex((c) => c.id === currentChannel.id) : -1;
    if (idx < 0) idx = dir > 0 ? -1 : 0;
    playChannel(liveChannels[(idx + dir + liveChannels.length) % liveChannels.length]);
  };

  // Country browser (mockup screen 1) vs a selected country's channels (screen 2).
  const showGrid = sidebarPanel === 'channels' && selectedCountry === null;
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
    () => history.map((h) => ({ ...h, group: 'History' })),
    [history]
  );

  const progs = currentChannel ? programmesForChannel(epg, currentChannel) : [];
  const { now, next } = findNowNext(progs);

  let leftContent;
  if (sidebarPanel === 'epg') {
    leftContent = <EpgGuide channels={liveChannels} onSelect={playChannel} />;
  } else if (sidebarPanel === 'history') {
    leftContent = <ChannelList channels={historyChannels} onSelect={playChannel} />;
  } else {
    leftContent = <ChannelList channels={liveChannels} onSelect={playChannel} />;
  }

  const listCount = sidebarPanel === 'history' ? historyChannels.length : liveChannels.length;

  // Mockup screen 1 — full-width country browser.
  if (showGrid) {
    return (
      <div className="md:ml-20 pt-24 md:pt-28 px-4 md:px-8 pb-8 min-h-screen">
        <CountryGrid onSelect={setSelectedCountry} />
      </div>
    );
  }

  return (
    <div className="md:ml-20 pt-24 md:pt-28 px-4 md:px-8 pb-8 min-h-screen">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: list — on mobile it stacks BELOW the player (order-3) */}
        <div className="order-3 lg:order-none lg:col-span-5 xl:col-span-4 flex flex-col gap-3">
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
              <h2 className="text-2xl font-semibold text-primary">{PANEL_TITLES[sidebarPanel] || 'Channels'}</h2>
              <p className="text-on-surface-variant text-sm">Live Now • {listCount} Channels</p>
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
                  <Icon name="live_tv" fill className="text-primary text-3xl" />
                  <div>
                    <h1 className="text-2xl md:text-3xl font-semibold">{now?.title || currentChannel.name}</h1>
                    <p className="text-on-surface-variant text-sm">{currentChannel.name} • {currentChannel.group}</p>
                  </div>
                </div>
                <div className="flex gap-3 flex-wrap">
                  <FavouriteButton channelId={currentChannel.id} variant="pill" />
                  <button
                    onClick={() =>
                      isRecording ? stopRecording(activeRec.id) : startRecording(currentChannel, now)
                    }
                    aria-pressed={isRecording}
                    className={`px-5 py-2.5 rounded-full flex items-center gap-2 transition-all ${
                      isRecording
                        ? 'bg-red-500/20 border border-red-500 text-red-300 hover:bg-red-500/30'
                        : 'glass hover:bg-white/10'
                    }`}
                  >
                    {isRecording ? (
                      <>
                        <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                        <span className="font-mono text-xs">Stop Recording</span>
                      </>
                    ) : (
                      <>
                        <Icon name="fiber_manual_record" className="text-error" />
                        <span className="font-mono text-xs">Record</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {now?.desc && <p className="text-on-surface-variant max-w-3xl">{now.desc}</p>}

              {now && (
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
    </div>
  );
}
