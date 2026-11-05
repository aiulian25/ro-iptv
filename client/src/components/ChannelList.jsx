import { useGuideTime } from '../hooks/useGuideTime';
import { useEffect, useRef, useState, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { programmesForChannel, findNowNext, progressPct, epgIconFor } from '../lib/epg';
import ChannelLogo from './ChannelLogo';
import FavouriteButton from './FavouriteButton';
import Icon from './Icon';

const PAGE = 40;
const WINDOW = 200;

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

// Grow a bounded page on scroll; release its rows when moving to another page.
export default function ChannelList({ channels, onSelect }) {
  const [limit, setLimit] = useState(PAGE);
  const [pageStart, setPageStart] = useState(0);
  const listRef = useRef(null);
  const focusPageRef = useRef(false);
  const sentinelRef = useRef(null);
  const at = new Date(useGuideTime());
  const epg = useStore((s) => s.epg);
  const overrides = useStore((s) => s.settings.epgOverrides || {});
  const currentChannel = useStore((s) => s.currentChannel);

  // A stable signature for the channel *set*. The parent re-derives the array on
  // every store change (new reference, same content), so we must NOT reset on the
  // reference — only when the actual list changes (filter/search/playlist switch).
  const count = channels.length;
  const signature = `${count}:${channels[0]?.id || ''}:${channels[count - 1]?.id || ''}`;

  useEffect(() => {
    setLimit(PAGE);
    setPageStart(0);
  }, [signature]);

  useEffect(() => {
    if (!focusPageRef.current) return;
    focusPageRef.current = false;
    const first = listRef.current?.querySelector('button');
    first?.focus({ preventScroll: true });
    first?.scrollIntoView({ block: 'nearest' });
  }, [pageStart]);

  function changePage(start) {
    focusPageRef.current = true;
    setLimit(PAGE);
    setPageStart(start);
  }

  // Re-arm after each load so the (moved) sentinel is re-evaluated; this chains
  // loads while the sentinel stays near the bottom, then stops at the cap.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setLimit((l) => Math.min(l + PAGE, count - pageStart, WINDOW));
        }
      },
      { root: getScrollParent(el), rootMargin: '400px 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [signature, limit, count, pageStart]);

  const visible = useMemo(() => channels.slice(pageStart, pageStart + limit), [channels, limit, pageStart]);

  if (!channels.length) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-on-surface-variant gap-3">
        <Icon aria-hidden="true" name="tv_off" className="text-5xl opacity-60" />
        <p>No channels here yet.</p>
      </div>
    );
  }

  return (
    <div ref={listRef} className="flex flex-col gap-2.5">
      {visible.map((c) => {
        const progs = programmesForChannel(epg, c, overrides);
        const { now, next } = findNowNext(progs, at);
        const isActive = currentChannel?.id === c.id;
        return (
          <div
            key={c.id}
            className={`glass flex items-center gap-4 p-3 rounded-xl cursor-pointer transition-all border ${
              isActive
                ? 'border-primary border-l-4 shadow-[0_0_20px_rgba(192,193,255,0.2)] scale-[1.01]'
                : 'border-transparent hover:bg-surface-variant/30 hover:border-white/10'
            }`}
          >
            <button type="button" onClick={() => onSelect(c)} aria-label={`Play ${c.name}`} aria-current={isActive ? 'true' : undefined} className="flex flex-1 min-w-0 items-center gap-4 text-left rounded-lg min-h-11">
              {c.chno != null && (
                <span className="font-mono text-xs text-on-surface-variant w-8 shrink-0 text-right">{c.chno}</span>
              )}
              <ChannelLogo src={c.logo || epgIconFor(epg, c)} kind={c.kind} className="w-16 h-12" />
              <span className="flex-1 min-w-0">
                <span className="block text-base font-semibold truncate">{c.name}</span>
                <span className="block text-sm text-on-surface-variant truncate">
                  {now ? (
                    <>
                      <span className="text-primary">●</span> {now.title}
                    </>
                  ) : (
                    c.group
                  )}
                </span>
                {now && (
                  <span className="block mt-1.5 h-1 w-full bg-surface-variant rounded-full overflow-hidden">
                    <span className="block bg-primary h-full" style={{ width: `${progressPct(now, at)}%` }} />
                  </span>
                )}
                {next && <span className="block text-xs text-on-surface-variant/70 mt-1 truncate">Next: {next.title}</span>}
              </span>
            </button>
            <FavouriteButton channelId={c.id} channelName={c.name} className="p-2 min-w-11 min-h-11" />
          </div>
        );
      })}
      {limit < Math.min(WINDOW, count - pageStart) && (
        <div ref={sentinelRef} className="py-6 text-center text-on-surface-variant text-sm">
          Loading more… ({pageStart + limit}/{channels.length})
        </div>
      )}
      {count > WINDOW && (
        <nav aria-label="Channel pages" className="flex flex-wrap items-center justify-center gap-3 py-4">
          <button type="button" disabled={pageStart === 0} onClick={() => changePage(Math.max(0, pageStart - WINDOW))} className="min-h-11 px-3 rounded-lg bg-surface-variant disabled:opacity-50">Previous 200</button>
          <span className="text-sm text-on-surface-variant">{pageStart + 1}–{Math.min(pageStart + WINDOW, count)} of {count}</span>
          <button type="button" disabled={pageStart + WINDOW >= count} onClick={() => changePage(pageStart + WINDOW)} className="min-h-11 px-3 rounded-lg bg-surface-variant disabled:opacity-50">Next 200</button>
        </nav>
      )}
    </div>
  );
}
