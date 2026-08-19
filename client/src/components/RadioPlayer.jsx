import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { attachStream } from '../lib/playSource';
import ChannelLogo from './ChannelLogo';
import FavouriteButton from './FavouriteButton';
import { useMediaSession } from '../hooks/useMediaSession';
import { useStore } from '../store/useStore';
import { api } from '../lib/api';
import { programmesForChannel, findNowNext, fmtTime, progressPct } from '../lib/epg';

const BAR_COUNT = 14;
// Track changes are minutes apart; the server caches each probe for 15s, so this
// is about how fast a change surfaces, not how hard the station is hit.
const NOW_PLAYING_POLL_MS = 20_000;

// Right-hand "Now Playing" radio panel: vinyl animation + Web Audio visualizer.
export default function RadioPlayer({ station, onPrev, onNext, onStop }) {
  const audioRef = useRef(null);
  const hlsRef = useRef(null);
  const rafRef = useRef(null);
  const barsRef = useRef([]);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.9);
  const [error, setError] = useState(null);
  const [nowPlaying, setNowPlaying] = useState(null);
  const epg = useStore((s) => s.epg);
  const epgOverrides = useStore((s) => s.settings.epgOverrides || {});

  // A station can be in a guide like any other channel (Freeview publishes radio),
  // so Now/Next comes from exactly the same matching Live TV uses.
  const programmes = station ? programmesForChannel(epg, station, epgOverrides) : [];
  const { now, next } = findNowNext(programmes);

  // Two sources, in order of specificity: the track the stream is playing right
  // now, then the scheduled programme. Neither is invented — when a station tells
  // us nothing, the line simply isn't shown. Tagged with the station it came from,
  // so switching stations can never show the previous one's track for a frame.
  const current = nowPlaying?.url === station?.url ? nowPlaying : null;
  const trackTitle = current?.title || '';
  const headline = trackTitle || now?.title || station?.name || '';
  const bitrate = current?.bitrate ? `${current.bitrate} kbps` : '';

  // OS media controls (lock screen / headset / car) for the playing station.
  useMediaSession({ mediaRef: audioRef, channel: station, playing, onPrev, onNext, onStop, trackTitle });

  // Ask the stream what it is playing, but only while it actually is: a paused
  // player must not keep opening connections to the station.
  useEffect(() => {
    if (!station || !playing) return undefined;
    let cancelled = false;
    const url = station.url;
    const poll = () => {
      api
        .nowPlaying(url, station.httpUserAgent)
        .then((data) => {
          // An empty answer means "nothing new" far more often than "the music
          // stopped" — a momentary miss must not blank a title that still stands.
          if (!cancelled) {
            setNowPlaying((previous) =>
              data.title || !previous || previous.url !== url ? { ...data, url } : previous
            );
          }
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, NOW_PLAYING_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [station, playing]);

  // Load the stream when station changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !station) return;
    setError(null);
    audio.volume = volume;
    const isHls = /\.m3u8(\?|$)/i.test(station.url || '');
    const stop = attachStream(audio, station, {
      hlsRef,
      isHls,
      onManifest: () => audio.play().catch(() => {}),
      onError: () => setError('Stream unavailable'),
    });

    return () => {
      stop();
      audio.removeAttribute('src');
      audio.load?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station]);

  // Synthetic visualizer. We deliberately DON'T route the audio through the Web
  // Audio API: a MediaElementSource graph gets suspended when the screen locks /
  // app backgrounds on mobile, which kills background playback. Playing the audio
  // element directly lets it keep going in the background (with Media Session).
  useEffect(() => {
    const tick = () => {
      const bars = barsRef.current;
      if (bars.length) {
        for (let i = 0; i < bars.length; i++) {
          if (bars[i]) bars[i].style.height = playing ? `${4 + Math.random() * 40}px` : '4px';
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  const togglePlay = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play();
    else a.pause();
  };

  const onVolume = (e) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  };

  if (!station) {
    return (
      <div className="glass-panel glass rounded-[40px] p-10 flex flex-col items-center justify-center h-full text-center text-on-surface-variant">
        <Icon name="radio" className="text-6xl mb-4 text-primary/60" />
        <p>Select a station to start listening</p>
      </div>
    );
  }

  return (
    <div className="glass rounded-[40px] p-6 md:p-8 flex flex-col items-center justify-between h-full relative overflow-hidden">
      <audio ref={audioRef} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} preload="auto" />
      <div className="absolute -top-20 -right-20 w-64 h-64 bg-primary/20 blur-[100px] rounded-full" />
      <div className="absolute -bottom-20 -left-20 w-64 h-64 bg-secondary/20 blur-[100px] rounded-full" />

      <div className="text-center w-full z-10">
        <div className="flex items-center justify-center gap-2 mb-3">
          <span className={`w-2 h-2 rounded-full ${playing ? 'bg-red-500 animate-pulse' : 'bg-on-surface-variant'}`} />
          <span className="font-mono text-xs uppercase text-on-surface-variant">
            {error ? 'Offline' : playing ? 'Live Broadcast' : 'Paused'}
          </span>
        </div>
        <h2 className="text-2xl font-semibold text-on-surface truncate px-4">{station.name}</h2>
        <p className="text-on-surface-variant text-sm uppercase tracking-widest mt-1">{station.group}</p>
      </div>

      {/* Vinyl */}
      <div className="relative w-48 h-48 md:w-60 md:h-60 z-10">
        <div
          className={`relative w-full h-full rounded-full bg-[#0a0a0a] border-8 border-surface-container-highest shadow-2xl flex items-center justify-center overflow-hidden ${playing ? 'animate-spin-slow' : ''}`}
        >
          <div
            className="absolute inset-0 opacity-20"
            style={{ background: 'repeating-radial-gradient(circle, #000 0%, #000 1%, #333 1.5%)' }}
          />
          <div className="w-20 h-20 md:w-24 md:h-24 rounded-full overflow-hidden z-10 shadow-inner">
            <ChannelLogo src={station.logo} kind="radio" rounded="rounded-full" className="w-full h-full" />
          </div>
        </div>
        <div className="absolute top-0 right-0 w-28 h-28 pointer-events-none -rotate-12">
          <div className="w-2 h-20 bg-on-surface-variant rounded-full origin-top rotate-45 ml-auto shadow-lg" />
        </div>
      </div>

      <div className="text-center w-full z-10 px-4">
        <h3 className="text-xl font-semibold text-primary line-clamp-2 break-words">{headline}</h3>
        {next && (
          <p className="text-sm text-on-surface-variant truncate mt-0.5">
            Next: {next.title} • {fmtTime(next.start)}
          </p>
        )}
        {now && (
          <div className="mt-2 h-1 w-full max-w-xs mx-auto bg-surface-variant rounded-full overflow-hidden">
            <div className="bg-primary h-full" style={{ width: `${progressPct(now)}%` }} />
          </div>
        )}
        {bitrate && <p className="font-mono text-xs text-on-surface-variant mt-1">{bitrate}</p>}
      </div>

      {/* Visualizer */}
      <div className="flex items-end justify-center gap-1.5 h-12 w-full px-6 z-10">
        {Array.from({ length: BAR_COUNT }).map((_, i) => (
          <div
            key={i}
            ref={(el) => (barsRef.current[i] = el)}
            className="visualizer-bar transition-[height] duration-100"
            style={{ height: '4px' }}
          />
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between w-full px-5 py-3 bg-white/5 rounded-3xl border border-white/5 z-10">
        <FavouriteButton channelId={station.id} size="text-2xl" className="p-2" />
        <div className="flex items-center gap-4 md:gap-6">
          <button onClick={onPrev} className="p-2 text-on-surface-variant hover:text-white">
            <Icon name="skip_previous" className="text-2xl" />
          </button>
          <button
            onClick={togglePlay}
            className="w-14 h-14 bg-primary text-on-primary rounded-full flex items-center justify-center shadow-lg hover:scale-110 transition-transform"
          >
            <Icon name={playing ? 'pause' : 'play_arrow'} fill className="text-3xl" />
          </button>
          <button onClick={onNext} className="p-2 text-on-surface-variant hover:text-white">
            <Icon name="skip_next" className="text-2xl" />
          </button>
        </div>
        <div className="flex items-center gap-1">
          <Icon name="volume_up" className="text-xl text-on-surface-variant" />
          <input type="range" min="0" max="1" step="0.05" value={volume} onChange={onVolume} className="w-14 accent-primary" />
        </div>
      </div>
    </div>
  );
}
