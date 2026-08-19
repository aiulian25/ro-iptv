import { useEffect } from 'react';

// Wires media playback to the OS Media Session — now-playing metadata + action
// handlers (play/pause/stop/prev/next) that surface on the lock screen,
// notification, Bluetooth/headset buttons, car head-unit, watch and media keys.
//
// Several players can be mounted at once (the in-view player + the always-mounted
// mini-player), but the OS Media Session is a single global. So handlers are
// installed ONCE and indirect through a module-level "controller" that points at
// whichever player is currently active. Only the player with a non-null channel
// writes to it, and at most one is active at a time.

const hasMS = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
let handlersInstalled = false;
const ctl = { mediaRef: null, onPrev: null, onNext: null, onStop: null };

function installHandlers() {
  if (handlersInstalled || !hasMS) return;
  handlersInstalled = true;
  const set = (action, handler) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* action unsupported on this platform */
    }
  };
  set('play', () => ctl.mediaRef?.current?.play?.().catch(() => {}));
  set('pause', () => ctl.mediaRef?.current?.pause?.());
  set('stop', () => ctl.onStop?.());
  set('previoustrack', () => ctl.onPrev?.());
  set('nexttrack', () => ctl.onNext?.());

  // If the browser paused the media while hidden, resume it when the user comes
  // back to the app (so it doesn't sit silently paused after backgrounding).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const el = ctl.mediaRef?.current;
    if (el && el.paused && navigator.mediaSession.playbackState === 'playing') {
      el.play().catch(() => {});
    }
  });
}

// Clear the OS now-playing card (call when nothing is playing).
export function clearNowPlaying() {
  if (!hasMS) return;
  ctl.mediaRef = null;
  ctl.onPrev = null;
  ctl.onNext = null;
  ctl.onStop = null;
  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  } catch {
    /* ignore */
  }
}

export function useMediaSession({ mediaRef, channel, playing, onPrev, onNext, onStop, trackTitle = '' }) {
  // Point the global controller at this player while it's the active one. Runs
  // after every render so the callbacks/element stay current.
  useEffect(() => {
    if (!hasMS || !channel) return;
    installHandlers();
    ctl.mediaRef = mediaRef;
    ctl.onPrev = onPrev;
    ctl.onNext = onNext;
    ctl.onStop = onStop;
  });

  // Now-playing metadata — when the channel identity changes, or when the live
  // track does (radio reports the current song over ICY; see lib/icy.js).
  useEffect(() => {
    if (!hasMS || !channel || typeof window.MediaMetadata !== 'function') return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: trackTitle || channel.name || 'RO-IPTV',
        artist: trackTitle ? channel.name : channel.group || (channel.kind === 'radio' ? 'Radio' : 'Live TV'),
        album: 'RO-IPTV',
        artwork: channel.logo
          ? [
              { src: channel.logo, sizes: '96x96' },
              { src: channel.logo, sizes: '256x256' },
              { src: channel.logo, sizes: '512x512' },
            ]
          : [],
      });
    } catch {
      /* ignore */
    }
  }, [channel?.id, channel?.name, channel?.logo, channel?.group, channel?.kind, trackTitle]);

  // Reflect play/pause so the OS shows the right icon.
  useEffect(() => {
    if (!hasMS || !channel) return;
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    } catch {
      /* ignore */
    }
  }, [channel?.id, playing]);
}

export default useMediaSession;
