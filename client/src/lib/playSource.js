import Hls from 'hls.js';
import { sourceCandidates, memoDirect } from './api';

// Attach a channel's stream to a media element, trying its source candidates in
// order (direct then proxied). A fatal error DURING STARTUP — before the first
// segment/frame plays — advances to the next candidate; once playback has begun,
// errors fall through to the caller's onError (its normal recovery). Records the
// direct/proxied outcome so later plays of the same URL skip re-probing.
//
// Callbacks let each player keep its own UI: onManifest(levels-data), onLevelSwitched(level),
// onError(fatalData). onError also receives { native: true } / { unsupported: true } sentinels
// for the non-HLS paths. Returns a stop() to call from the effect cleanup.
export function attachStream(media, channel, opts = {}) {
  const { hlsRef, isHls, hlsConfig = {}, onManifest, onLevelSwitched, onError } = opts;
  const candidates = sourceCandidates(channel);
  let attempt = 0;
  let started = false;
  let removeNativeOk = null;

  const destroyHls = () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  };

  const detachNative = () => {
    if (removeNativeOk) {
      removeNativeOk();
      removeNativeOk = null;
    }
  };

  // Move to the next candidate on a startup failure. Returns false once playback
  // has started or the candidates are exhausted (caller handles the error then).
  const advance = () => {
    if (started || attempt + 1 >= candidates.length) return false;
    memoDirect(channel.url, false);
    attempt += 1;
    load(candidates[attempt]);
    return true;
  };

  function load(src) {
    const direct = src === channel.url;
    destroyHls();
    detachNative();

    if (isHls && Hls.isSupported()) {
      const hls = new Hls(hlsConfig);
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(media);
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (direct) memoDirect(channel.url, true);
        onManifest?.(data);
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => onLevelSwitched?.(data.level));
      hls.on(Hls.Events.FRAG_LOADED, () => {
        started = true;
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (advance()) return;
        onError?.(data);
      });
      return;
    }

    if (media.canPlayType?.('application/vnd.apple.mpegurl') || !isHls) {
      media.src = src;
      media.play?.().catch(() => {});
      const onOk = () => {
        started = true;
        if (direct) memoDirect(channel.url, true);
      };
      media.addEventListener('loadeddata', onOk);
      removeNativeOk = () => media.removeEventListener('loadeddata', onOk);
      media.onerror = () => {
        if (!advance()) onError?.({ native: true });
      };
      return;
    }

    onError?.({ unsupported: true });
  }

  load(candidates[0]);

  return () => {
    destroyHls();
    detachNative();
  };
}
