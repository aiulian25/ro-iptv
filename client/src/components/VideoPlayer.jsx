import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import Hls from 'hls.js';
import Icon from './Icon';
import { proxied } from '../lib/api';
import { useMediaSession } from '../hooks/useMediaSession';

// HLS.js for .m3u8; native <video> for progressive MP4. Includes keyboard
// shortcuts (space/f/m), fullscreen, PiP, and a quality selector.
// Exposes an imperative handle so parents can trigger fullscreen / play.
const VideoPlayer = forwardRef(function VideoPlayer({ channel, onPrev, onNext, onStop }, ref) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const containerRef = useRef(null);
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showQuality, setShowQuality] = useState(false);

  const isHls = channel && /\.m3u8(\?|$)/i.test(channel.url || '');

  // OS media controls (lock screen / headset / car) while the player is mounted.
  useMediaSession({ mediaRef: videoRef, channel, playing, onPrev, onNext, onStop });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !channel) return;
    setError(null);
    setLevels([]);
    setCurrentLevel(-1);

    // Route through backend proxy to defeat CORS / mixed-content issues.
    const src = proxied(channel.url);

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, enableWorker: true, backBufferLength: 30 });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
        setLevels(data.levels || []);
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => setCurrentLevel(data.level));
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              setError('This stream could not be played.');
              hls.destroy();
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl') || !isHls) {
      // Native HLS (Safari) or direct progressive media.
      video.src = src;
      video.play().catch(() => {});
      video.onerror = () => setError('This stream could not be played.');
    } else {
      setError('HLS is not supported in this browser.');
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.removeAttribute('src');
      video.load?.();
    };
  }, [channel, isHls]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!document.fullscreenElement) el?.requestFullscreen?.();
    else document.exitFullscreen?.();
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* not supported */
    }
  }, []);

  // Let parents (e.g. the Live metadata panel) drive the player.
  useImperativeHandle(
    ref,
    () => ({
      enterFullscreen: () => containerRef.current?.requestFullscreen?.(),
      toggleFullscreen,
      togglePlay,
    }),
    [toggleFullscreen, togglePlay]
  );

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key.toLowerCase() === 'f') toggleFullscreen();
      else if (e.key.toLowerCase() === 'm') toggleMute();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, toggleFullscreen, toggleMute]);

  const selectLevel = (idx) => {
    if (hlsRef.current) hlsRef.current.currentLevel = idx;
    setCurrentLevel(idx);
    setShowQuality(false);
  };

  return (
    <div ref={containerRef} className="relative w-full h-full bg-black rounded-3xl overflow-hidden group">
      <video
        ref={videoRef}
        className="w-full h-full object-contain bg-black"
        playsInline
        autoPlay
        controls={false}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />

      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-center px-6">
          <Icon name="error" className="text-error text-5xl" />
          <p className="text-on-surface-variant">{error}</p>
        </div>
      )}

      {/* HD badge */}
      <div className="absolute top-4 right-4 glass px-3 py-1 rounded-full border border-primary/40">
        <span className="font-mono text-xs text-primary">{isHls ? 'HLS • LIVE' : 'DIRECT'}</span>
      </div>

      {/* Control bar */}
      <div className="absolute bottom-0 inset-x-0 p-3 md:p-4 bg-gradient-to-t from-black/80 to-transparent flex items-center gap-3 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
        <button onClick={togglePlay} className="text-white hover:text-primary">
          <Icon name={playing ? 'pause' : 'play_arrow'} fill className="text-3xl" />
        </button>
        <button onClick={toggleMute} className="text-white hover:text-primary">
          <Icon name={muted ? 'volume_off' : 'volume_up'} className="text-2xl" />
        </button>
        <div className="flex-1" />
        {levels.length > 1 && (
          <div className="relative">
            <button onClick={() => setShowQuality((s) => !s)} className="text-white hover:text-primary flex items-center gap-1">
              <Icon name="hd" className="text-2xl" />
              <span className="font-mono text-xs">
                {currentLevel === -1 ? 'AUTO' : `${levels[currentLevel]?.height || ''}p`}
              </span>
            </button>
            {showQuality && (
              <div className="absolute bottom-10 right-0 glass-dark rounded-lg p-1 min-w-[120px]">
                <button
                  onClick={() => selectLevel(-1)}
                  className={`block w-full text-left px-3 py-1.5 rounded text-sm hover:bg-white/10 ${currentLevel === -1 ? 'text-primary' : ''}`}
                >
                  Auto
                </button>
                {levels.map((l, i) => (
                  <button
                    key={i}
                    onClick={() => selectLevel(i)}
                    className={`block w-full text-left px-3 py-1.5 rounded text-sm hover:bg-white/10 ${currentLevel === i ? 'text-primary' : ''}`}
                  >
                    {l.height ? `${l.height}p` : `${Math.round((l.bitrate || 0) / 1000)}k`}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button onClick={togglePip} className="text-white hover:text-primary" title="Picture in Picture">
          <Icon name="picture_in_picture_alt" className="text-2xl" />
        </button>
        <button onClick={toggleFullscreen} className="text-white hover:text-primary" title="Fullscreen (f)">
          <Icon name="fullscreen" className="text-2xl" />
        </button>
      </div>
    </div>
  );
});

export default VideoPlayer;
