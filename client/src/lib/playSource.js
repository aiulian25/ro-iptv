import Hls from 'hls.js';
import { sourceCandidates, memoDirect, proxied } from './api';
import { sessionGeneration, sessionFetch } from './privacy';

const HLS_MIME = /^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/i;
const nativeMime = (mime) => /^(?:audio|video)\//i.test(mime) && !HLS_MIME.test(mime);
const mimeOf = (value) => String(value || '').split(';')[0].trim();

export function streamTypeHint(channel) {
  const mime = mimeOf(channel.mimeType || channel.contentType);
  if (HLS_MIME.test(mime) || channel.streamType === 'hls') return 'hls';
  if (nativeMime(mime)) return 'native';
  let pathname = '';
  try { pathname = new URL(channel.url, 'http://local.invalid').pathname; } catch { /* unknown */ }
  if (/\.m3u8$/i.test(pathname)) return 'hls';
  if (/\.(?:mp3|aac|m4a|mp4|webm|ogg|oga|wav|ts)$/i.test(pathname)) return 'native';
  return 'unknown';
}

// GET through the existing authenticated/guarded proxy, never provider-hostile
// HEAD or a complete media download. Retain at most 1 KiB, cancel the body and
// connection immediately, and bound the whole probe (including stalled headers).
export async function probeStreamType(channel, { signal, timeoutMs = 4000, sniff = false } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  let response, reader;
  try {
    response = await sessionFetch(proxied(channel.url, channel.httpUserAgent, channel.httpReferrer), {
      method: 'GET', credentials: 'same-origin', signal: controller.signal,
    });
    if (!response.ok) throw Object.assign(new Error('Stream type probe failed'), { status: response.status });
    const mime = mimeOf(response.headers.get('content-type'));
    if (HLS_MIME.test(mime)) return 'hls';
    if (!sniff && nativeMime(mime)) return 'native';
    reader = response.body?.getReader();
    if (!reader) return 'unknown';
    const prefix = new Uint8Array(1024); let length = 0;
    while (length < prefix.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, prefix.length - length); prefix.set(chunk, length); length += chunk.length;
      // A UTF-8 BOM may arrive across separate network chunks.
      if (length < 3 && prefix[0] === 0xef && (length === 1 || prefix[1] === 0xbb)) continue;
      const text = new TextDecoder().decode(prefix.subarray(0, length)).replace(/^\uFEFF/, '').trimStart();
      if (text.startsWith('#EXTM3U')) return 'hls';
      if (text && !'#EXTM3U'.startsWith(text)) break;
    }
    return nativeMime(mime) ? 'native' : 'unknown';
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (reader) reader.cancel().catch(() => {}); else response?.body?.cancel().catch(() => {});
    controller.abort();
  }
}

// One attachment owns detection, direct→proxy startup fallback and a finite
// recovery budget. Navigation never invokes this again; Stop cancels all work.
export function attachStream(media, channel, opts = {}) {
  const generation = sessionGeneration();
  const { hlsRef, hlsConfig = {}, onManifest, onLevelSwitched, onError, onType } = opts;
  const candidates = sourceCandidates(channel);
  let type = opts.isHls ? 'hls' : streamTypeHint(channel);
  let attempt = 0, started = false, stopped = false, terminal = false, epoch = 0;
  let forceProbed = false, resolving = false, removeNativeOk = null;
  const probe = new AbortController();
  const recoveries = { network: 0, media: 0 };
  const alive = () => !stopped && !terminal && generation === sessionGeneration();
  const destroyHls = () => { hlsRef.current?.destroy(); hlsRef.current = null; };
  const detachNative = () => { removeNativeOk?.(); removeNativeOk = null; media.onerror = null; };
  const fail = (data) => {
    if (!alive()) return;
    terminal = true; probe.abort(); destroyHls(); detachNative();
    media.pause?.(); media.removeAttribute?.('src'); media.load?.();
    onError?.(data);
  };
  const detect = async (sniff = false) => {
    try { return await probeStreamType(channel, { signal: probe.signal, timeoutMs: opts.probeTimeoutMs || 4000, sniff }); }
    catch (error) {
      if (!alive()) return 'unknown';
      if (error.status) fail({ probeFailed: true, status: error.status });
      // Offline/probe deadline: one native attempt remains possible, without
      // another probe or an unbounded retry sequence.
      forceProbed = true;
      return 'unknown';
    }
  };
  const advance = () => {
    if (!alive() || started || attempt + 1 >= candidates.length) return false;
    memoDirect(channel.url, false, generation); attempt++; load(candidates[attempt], type); return true;
  };
  const hlsError = (data, instance) => {
    if (!alive()) return;
    if (/incompatiblecodec|addcodec/i.test(data.details || '')) return fail({ unsupportedCodec: true });
    if (advance()) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recoveries.network++ < 1) return instance.startLoad();
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries.media++ < 1) return instance.recoverMediaError();
    fail({ terminal: true });
  };
  function load(src, detected) {
    if (!alive()) return;
    const token = ++epoch, direct = src === channel.url;
    destroyHls(); detachNative(); type = detected; onType?.(type);
    if (type === 'hls' && Hls.isSupported()) {
      const instance = new Hls(hlsConfig); hlsRef.current = instance;
      instance.loadSource(src); instance.attachMedia(media);
      instance.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        if (!alive() || token !== epoch) return;
        if (direct) memoDirect(channel.url, true, generation); onManifest?.(data);
      });
      instance.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => { if (alive() && token === epoch) onLevelSwitched?.(data.level); });
      instance.on(Hls.Events.FRAG_LOADED, () => { if (alive() && token === epoch) started = true; });
      instance.on(Hls.Events.ERROR, async (_e, data) => {
        if (!alive() || token !== epoch || !data.fatal || resolving) return;
        if (/manifestParsingError/i.test(data.details || '') && !forceProbed) {
          forceProbed = true; resolving = true; const revised = await detect(true); resolving = false;
          if (!alive() || token !== epoch) return;
          if (revised === 'native') return load(src, revised);
        }
        hlsError(data, instance);
      });
      return;
    }
    if (type === 'hls' && !media.canPlayType?.('application/vnd.apple.mpegurl')) return fail({ unsupported: true });
    media.src = src; media.play?.().catch(() => {});
    const onOk = () => { if (!alive() || token !== epoch) return; started = true; if (direct) memoDirect(channel.url, true, generation); };
    media.addEventListener('loadeddata', onOk); removeNativeOk = () => media.removeEventListener('loadeddata', onOk);
    media.onerror = async () => {
      if (!alive() || token !== epoch || resolving) return;
      if (type !== 'hls' && !forceProbed) {
        forceProbed = true; resolving = true; const revised = await detect(true); resolving = false;
        if (!alive() || token !== epoch) return;
        if (revised === 'hls') return load(src, revised);
      }
      if (!advance()) fail({ native: true, unsupportedCodec: media.error?.code === 3 || media.error?.code === 4 });
    };
  }
  if (type === 'unknown') {
    resolving = true;
    detect().then(detected => { resolving = false; if (alive()) load(candidates[attempt], detected); });
  } else load(candidates[0], type);
  return () => { stopped = true; probe.abort(); destroyHls(); detachNative(); };
}
