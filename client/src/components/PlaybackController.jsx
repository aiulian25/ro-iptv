import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { useFloatingBox } from '../hooks/useFloatingBox';
import { clearNowPlaying } from '../hooks/useMediaSession';
import VideoPlayer from './VideoPlayer';
import RadioPlayer from './RadioPlayer';
import { playbackNavigationFor } from './PlaybackSlot';

// The media tree stays here across navigation. Views supply layout slots only;
// changing its fixed geometry never reparents/remounts a media element (or PiP).
export default function PlaybackController() {
  const channel = useStore((s) => s.currentChannel);
  const view = useStore((s) => s.view);
  const playPrev = useStore((s) => s.playPrev);
  const playNext = useStore((s) => s.playNext);
  const onStop = useStore((s) => s.stopPlayback);
  const setView = useStore((s) => s.setView);
  const preferences = useRef({ volume: 0.9, muted: false });
  const radio = channel?.kind === 'radio';
  const home = radio ? 'radio' : 'live';
  const onPrev = () => (playbackNavigationFor(home)?.onPrev || playPrev)();
  const onNext = () => (playbackNavigationFor(home)?.onNext || playNext)();
  const full = !!channel && view === home;
  const [slot, setSlot] = useState(null);
  const floating = useFloatingBox({ storageKey: 'ro-iptv:miniwin', defaultWidth: 340 });

  useLayoutEffect(() => {
    if (!full) { setSlot(null); return; }
    let frame = 0, anchor = null;
    const observer = new ResizeObserver(() => update());
    const measure = () => {
      const next = document.querySelector(`[data-playback-slot="${home}"]`);
      if (next !== anchor) { observer.disconnect(); anchor = next; if (anchor) observer.observe(anchor); }
      if (!anchor) { setSlot(null); return; }
      const r = anchor.getBoundingClientRect();
      setSlot(previous => previous && previous.left === r.left && previous.top === r.top && previous.width === r.width && previous.height === r.height
        ? previous : { position: 'fixed', left: r.left, top: r.top, width: r.width, height: r.height });
    };
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    // Live's country browser can add/remove its player slot without navigation.
    const layout = new MutationObserver(update);
    layout.observe(document.querySelector('main') || document.body, { childList: true, subtree: true });
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); layout.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [full, home]);
  useEffect(() => { if (!channel) clearNowPlaying(); }, [channel]);
  useEffect(() => () => clearNowPlaying(), []);

  if (!channel) return null;
  const compact = !full || !slot;
  const style = !compact ? slot : radio
    ? { position: 'fixed', bottom: 12, left: 12, right: 12 }
    : floating.style;
  return (
    <section data-playback-owner data-playback-mode={compact ? 'mini' : 'full'}
      style={{ ...style, zIndex: compact ? 50 : 30 }}
      onFocusCapture={() => { if (!compact) document.querySelector(`[data-playback-slot="${home}"]`)?.scrollIntoView({ block: 'nearest' }); }}
      className={compact && !radio ? 'bg-black rounded-xl shadow-2xl overflow-hidden border border-white/15' : ''}
      onPointerDown={compact && !radio ? floating.startMove : undefined}>
      {radio ? <RadioPlayer station={channel} compact={compact} preferences={preferences} onPrev={onPrev} onNext={onNext} onStop={onStop} onExpand={() => setView(home)} />
        : <VideoPlayer channel={channel} compact={compact} preferences={preferences} onPrev={onPrev} onNext={onNext} onStop={onStop} onExpand={() => setView(home)} />}
      {compact && !radio && ['tl', 'tr', 'bl', 'br'].map(corner => <div key={corner} data-no-drag onPointerDown={floating.startResize(corner)} aria-label="Resize"
        className={`absolute w-5 h-5 z-10 touch-none ${corner[0] === 't' ? 'top-0' : 'bottom-0'} ${corner[1] === 'l' ? 'left-0' : 'right-0'} ${corner === 'tl' || corner === 'br' ? 'cursor-nwse-resize' : 'cursor-nesw-resize'}`} />)}
    </section>
  );
}
