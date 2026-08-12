import { useStore, loadLastChannel } from '../store/useStore';
import { useWeather } from '../hooks/useWeather';
import { useClock } from '../hooks/useClock';
import { programmesForChannel, findNowNext } from '../lib/epg';
import Icon from '../components/Icon';

function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

// IFI-style cinematic dashboard: large left-clustered category cards over an
// atmospheric background, with a big clock/weather widget bottom-right.
export default function HomeView() {
  const channels = useStore((s) => s.channels);
  const playlists = useStore((s) => s.playlists);
  const currentChannel = useStore((s) => s.currentChannel);
  const setView = useStore((s) => s.setView);
  const playChannel = useStore((s) => s.playChannel);
  const epg = useStore((s) => s.epg);
  const epgOverrides = useStore((s) => s.settings.epgOverrides || {});
  const weather = useWeather();
  const now = useClock();

  // Most recently updated enabled playlist drives the "last update" line.
  const enabled = playlists.filter((p) => p.enabled !== false);
  const latest = enabled.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
  const updated = timeAgo(latest?.updatedAt);
  const count = (kind) => channels.filter((c) => c.kind === kind).length;

  const cards = [
    { id: 'live', view: 'live', icon: 'live_tv', title: "Live TV's", sub: count('live') ? `${count('live')} Channels` : 'Add a playlist in Settings' },
    { id: 'radio', view: 'radio', icon: 'radio', title: 'Radios', sub: count('radio') ? `${count('radio')} Stations` : 'Add a playlist in Settings' },
  ];

  // Resume target: what's playing now, else the persisted last-played channel.
  const last = currentChannel || loadLastChannel();
  if (last) {
    const nowTitle = findNowNext(programmesForChannel(epg, last, epgOverrides)).now?.title;
    cards.push({
      id: 'continue',
      view: last.kind === 'radio' ? 'radio' : 'live',
      icon: 'resume',
      title: last.name,
      sub: nowTitle || 'Continue watching',
    });
  }

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div
      className="relative h-screen w-full overflow-hidden flex flex-col px-6 md:px-12 pt-24 md:pt-28 pb-8"
      style={{
        background:
          "linear-gradient(rgba(13,15,26,0.82), rgba(13,15,26,0.9)), url('/bg-home.jpg') center/cover no-repeat",
      }}
    >
      {/* Left-clustered, vertically-centred category cards */}
      <div className="flex-1 flex items-center">
        <div className="flex items-center gap-5 md:gap-7 overflow-x-auto no-scrollbar w-full py-4 -mx-1 px-1">
          {cards.map((card, i) => {
            const isActive = last ? card.id === 'continue' : i === 0;
            const isPlaying =
              currentChannel &&
              ((card.id === 'live' && currentChannel.kind !== 'radio') ||
                (card.id === 'radio' && currentChannel.kind === 'radio'));
            return (
              <button
                key={card.id}
                onClick={() => {
                  if (card.id === 'continue') playChannel(last);
                  setView(card.view);
                }}
                className={`group shrink-0 w-[230px] md:w-[260px] rounded-2xl flex flex-col text-left p-7 md:p-8 transition-all duration-300 hover:scale-[1.04] ${
                  isActive
                    ? 'card-gradient border-b-4 border-white/90 h-[440px] md:h-[460px] scale-[1.03]'
                    : 'glass h-[400px] md:h-[420px] opacity-80 hover:opacity-100'
                }`}
              >
                <div className="flex mb-auto">
                  {isPlaying ? (
                    <span className="bg-black/30 px-3 py-1 rounded-md flex items-center gap-2 text-xs">
                      <span className="w-2 h-2 bg-primary rounded-full animate-pulse" /> Playing…
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 text-xs text-on-surface-variant/70">
                      <Icon name="sync" className="text-sm" /> Last update: {updated}
                    </span>
                  )}
                </div>
                <Icon
                  name={card.icon}
                  className="text-[64px] text-white mb-4 group-hover:scale-110 transition-transform origin-left"
                />
                <h2 className="text-3xl font-semibold truncate">{card.title}</h2>
                <p className="text-lg text-on-surface-variant truncate">{card.sub}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Big clock / weather / date — bottom right */}
      <footer className="flex justify-end items-end shrink-0">
        <div className="text-right leading-none">
          {weather && (
            <div className="flex items-center justify-end gap-2 mb-2">
              <Icon name={weather.icon} fill className="text-2xl text-secondary" />
              <span className="text-2xl font-light">{weather.temp}°</span>
              <span className="font-mono text-[11px] text-on-surface-variant self-end mb-1">{weather.place}</span>
            </div>
          )}
          <div className="text-6xl md:text-7xl font-light tracking-tight tabular-nums">{time}</div>
          <div className="text-xl md:text-2xl font-light text-on-surface-variant mt-2">{date}</div>
        </div>
      </footer>
    </div>
  );
}
