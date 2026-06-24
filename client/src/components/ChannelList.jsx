import { useEffect, useRef, useState, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { programmesForChannel, findNowNext, progressPct } from '../lib/epg';
import ChannelLogo from './ChannelLogo';
import FavouriteButton from './FavouriteButton';
import Icon from './Icon';

const PAGE = 40;

// Nearest scrolling ancestor — the IntersectionObserver root must be the real
// scroll container, not the viewport, for infinite scroll inside an overflow div.
function getScrollParent(node) {
  let el = node?.parentElement;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if (oy === 'auto' || oy === 'scroll') return el;
    el = el.parentElement;
  }
  return null;
}

// Lazy-rendered channel list (handles 1000+ items by growing the window on scroll).
export default function ChannelList({ channels, onSelect }) {
  const [limit, setLimit] = useState(PAGE);
  const sentinelRef = useRef(null);
  const epg = useStore((s) => s.epg);
  const currentChannel = useStore((s) => s.currentChannel);

  // A stable signature for the channel *set*. The parent re-derives the array on
  // every store change (new reference, same content), so we must NOT reset on the
  // reference — only when the actual list changes (filter/search/playlist switch).
  const count = channels.length;
  const signature = `${count}:${channels[0]?.id || ''}:${channels[count - 1]?.id || ''}`;

  useEffect(() => {
    setLimit(PAGE);
  }, [signature]);

  // Re-arm after each load so the (moved) sentinel is re-evaluated; this chains
  // loads while the sentinel stays near the bottom, then stops at the cap.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLimit((l) => (l < count ? Math.min(l + PAGE, count) : l));
        }
      },
      { root: getScrollParent(el), rootMargin: '400px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [signature, limit, count]);

  const visible = useMemo(() => channels.slice(0, limit), [channels, limit]);

  if (!channels.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-on-surface-variant gap-3">
        <Icon name="tv_off" className="text-5xl opacity-60" />
        <p>No channels here yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {visible.map((c) => {
        const progs = programmesForChannel(epg, c);
        const { now, next } = findNowNext(progs);
        const isActive = currentChannel?.id === c.id;
        return (
          <div
            key={c.id}
            onClick={() => onSelect(c)}
            className={`glass flex items-center gap-4 p-3 rounded-xl cursor-pointer transition-all border ${
              isActive
                ? 'border-primary border-l-4 shadow-[0_0_20px_rgba(192,193,255,0.2)] scale-[1.01]'
                : 'border-transparent hover:bg-surface-variant/30 hover:border-white/10'
            }`}
          >
            <ChannelLogo src={c.logo} kind={c.kind} className="w-16 h-12" />
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold truncate">{c.name}</h3>
              <p className="text-sm text-on-surface-variant truncate">
                {now ? (
                  <>
                    <span className="text-primary">●</span> {now.title}
                  </>
                ) : (
                  c.group
                )}
              </p>
              {now && (
                <div className="mt-1.5 h-1 w-full bg-surface-variant rounded-full overflow-hidden">
                  <div className="bg-primary h-full" style={{ width: `${progressPct(now)}%` }} />
                </div>
              )}
              {next && <p className="text-xs text-on-surface-variant/70 mt-1 truncate">Next: {next.title}</p>}
            </div>
            <FavouriteButton channelId={c.id} className="p-1" />
          </div>
        );
      })}
      {limit < channels.length && (
        <div ref={sentinelRef} className="py-6 text-center text-on-surface-variant text-sm">
          Loading more… ({limit}/{channels.length})
        </div>
      )}
    </div>
  );
}
