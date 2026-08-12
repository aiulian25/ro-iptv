import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { useStore } from '../store/useStore';
import { attachStream } from '../lib/playSource';
import { useMediaSession } from '../hooks/useMediaSession';
import { useFloatingBox } from '../hooks/useFloatingBox';
import Icon from './Icon';
import ChannelLogo from './ChannelLogo';

// The full-screen view that "owns" a channel of this kind.
function homeViewFor(kind) {
  return kind === 'radio' ? 'radio' : 'live';
}

// Persistent mini-player. It keeps a channel playing while the user navigates
// away from Live TV / Radio so playback never stops just because you left the
// page. Video shows as a draggable, corner-resizable FLOATING WINDOW (in-app
// PiP, works in web + PWA); radio shows as a compact bottom bar. Native PiP +
// Media Session keep playback alive in the background.
export default function MiniPlayer() {
  const currentChannel = useStore((s) => s.currentChannel);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const stopPlayback = useStore((s) => s.stopPlayback);
  const playNext = useStore((s) => s.playNext);
  const playPrev = useStore((s) => s.playPrev);

  const mediaRef = useRef(null);
  const hlsRef = useRef(null);
  const [playing, setPlaying] = useState(true);
  const [pip, setPip] = useState(false);

  // Floating window geometry (drag + corner resize, 16:9). Hook is unconditional.
  const { style, startMove, startResize } = useFloatingBox({ storageKey: 'ro-iptv:miniwin', defaultWidth: 340 });

  // Active only when something is playing AND we're off its full-screen view.
  const active = !!currentChannel && view !== 'live' && view !== 'radio';
  const isVideo = !!currentChannel && currentChannel.kind !== 'radio';

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !active || !currentChannel) return;
    const isHls = /\.m3u8(\?|$)/i.test(currentChannel.url || '');
    const stop = attachStream(el, currentChannel, {
      hlsRef,
      isHls,
      hlsConfig: { lowLatencyMode: true, enableWorker: true },
      onManifest: () => el.play().catch(() => {}),
      onError: (d) => {
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hlsRef.current?.startLoad();
      },
    });
    return () => {
      stop();
      el.removeAttribute('src');
      el.load?.();
    };
  }, [active, currentChannel]);

  useMediaSession({
    mediaRef,
    channel: active ? currentChannel : null,
    playing,
    onPrev: playPrev,
    onNext: playNext,
    onStop: stopPlayback,
  });

  const togglePlay = () => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  };

  const togglePip = async () => {
    const el = mediaRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await el.requestPictureInPicture();
    } catch {
      /* not supported (e.g. audio-only) */
    }
  };

  const expand = () => setView(homeViewFor(currentChannel.kind));

  if (!active) return null;

  const canPip = isVideo && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;

  // ---- Video: floating, draggable, corner-resizable window --------------------
  if (isVideo) {
    const handle = 'absolute w-5 h-5 z-10 touch-none';
    return (
      <div
        style={style}
        onPointerDown={startMove}
        className="z-50 rounded-xl overflow-hidden bg-black shadow-2xl border border-white/15 group cursor-move select-none"
      >
        <video
          ref={mediaRef}
          className="w-full h-full object-contain bg-black pointer-events-none"
          playsInline
          autoPlay
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnterPictureInPicture={() => setPip(true)}
          onLeavePictureInPicture={() => setPip(false)}
        />

        {/* Controls overlay (drag still works on empty areas; buttons are no-drag) */}
        <div className="absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/70 via-transparent to-black/50 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <div className="flex items-center justify-between gap-2 p-1.5">
            <span className="text-[11px] font-medium truncate text-white/90 px-1">{currentChannel.name}</span>
            <button data-no-drag onClick={stopPlayback} className="text-white/80 hover:text-error" aria-label="Stop">
              <Icon name="close" className="text-lg" />
            </button>
          </div>
          <div className="flex items-center justify-center gap-1.5 pb-1.5">
            <button data-no-drag onClick={playPrev} className="text-white/80 hover:text-primary" aria-label="Previous">
              <Icon name="skip_previous" className="text-xl" />
            </button>
            <button data-no-drag onClick={togglePlay} className="text-white hover:text-primary" aria-label={playing ? 'Pause' : 'Play'}>
              <Icon name={playing ? 'pause' : 'play_arrow'} fill className="text-2xl" />
            </button>
            <button data-no-drag onClick={playNext} className="text-white/80 hover:text-primary" aria-label="Next">
              <Icon name="skip_next" className="text-xl" />
            </button>
            {canPip && (
              <button data-no-drag onClick={togglePip} className="text-white/80 hover:text-primary" aria-label="Picture in picture" title="Native picture-in-picture">
                <Icon name="picture_in_picture_alt" className="text-lg" />
              </button>
            )}
            <button data-no-drag onClick={expand} className="text-white/80 hover:text-primary" aria-label="Open full player" title="Open full player">
              <Icon name="open_in_full" className="text-lg" />
            </button>
          </div>
        </div>

        {/* Corner resize handles */}
        <div data-no-drag onPointerDown={startResize('tl')} className={`${handle} top-0 left-0 cursor-nwse-resize`} aria-label="Resize" />
        <div data-no-drag onPointerDown={startResize('tr')} className={`${handle} top-0 right-0 cursor-nesw-resize`} aria-label="Resize" />
        <div data-no-drag onPointerDown={startResize('bl')} className={`${handle} bottom-0 left-0 cursor-nesw-resize`} aria-label="Resize" />
        <div data-no-drag onPointerDown={startResize('br')} className={`${handle} bottom-0 right-0 cursor-nwse-resize`}>
          {/* subtle grip on the dominant corner */}
          <span className="absolute bottom-0.5 right-0.5 w-2.5 h-2.5 border-b-2 border-r-2 border-white/50 rounded-sm" />
        </div>
      </div>
    );
  }

  // ---- Radio: compact bottom bar (nothing to resize) --------------------------
  return (
    <div className="fixed bottom-0 inset-x-0 z-40 px-3 pb-3 pointer-events-none">
      <div className="pointer-events-auto mx-auto max-w-3xl glass-dark rounded-2xl border border-white/10 shadow-2xl flex items-center gap-3 p-2 pr-3">
        <button onClick={expand} className="relative w-20 h-12 rounded-lg overflow-hidden shrink-0 bg-black" title="Open full player" aria-label="Open full player">
          <audio ref={mediaRef} autoPlay preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
          <ChannelLogo src={currentChannel.logo} kind="radio" className="w-full h-full" rounded="rounded-lg" />
        </button>

        <button onClick={expand} className="flex-1 min-w-0 text-left">
          <p className="text-sm font-semibold truncate">{currentChannel.name}</p>
          <p className="text-xs text-on-surface-variant truncate flex items-center gap-1">
            <span className={`w-1.5 h-1.5 rounded-full ${playing ? 'bg-primary' : 'bg-on-surface-variant'}`} />
            Radio
          </p>
        </button>

        <button onClick={playPrev} className="p-1.5 text-on-surface-variant hover:text-primary shrink-0 hidden sm:block" aria-label="Previous">
          <Icon name="skip_previous" className="text-xl" />
        </button>
        <button onClick={togglePlay} className="p-1.5 text-on-surface hover:text-primary shrink-0" aria-label={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'pause' : 'play_arrow'} fill className="text-2xl" />
        </button>
        <button onClick={playNext} className="p-1.5 text-on-surface-variant hover:text-primary shrink-0 hidden sm:block" aria-label="Next">
          <Icon name="skip_next" className="text-xl" />
        </button>
        <button onClick={expand} className="p-1.5 text-on-surface-variant hover:text-primary shrink-0 hidden sm:block" aria-label="Open full player" title="Open full player">
          <Icon name="open_in_full" className="text-xl" />
        </button>
        <button onClick={stopPlayback} className="p-1.5 text-on-surface-variant hover:text-error shrink-0" aria-label="Stop" title="Stop">
          <Icon name="close" className="text-xl" />
        </button>
      </div>
    </div>
  );
}
