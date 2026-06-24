import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useStore, selectCategoriesFor, isCountryScoped } from '../store/useStore';
import { channelCountry } from '../lib/country';
import Icon from './Icon';

// Scrollable category chips. Touch-swipeable everywhere (overflow-x + momentum);
// desktop gets prev/next arrows + edge fades that appear only when overflowing.
export default function CategoryChips({ kind }) {
  const channels = useStore((s) => s.channels);
  const active = useStore((s) => s.activeCategory);
  const setCategory = useStore((s) => s.setCategory);
  const selectedCountry = useStore((s) => s.selectedCountry);
  const sidebarPanel = useStore((s) => s.sidebarPanel);

  // Base list categories are computed from (kind + current country scope).
  const cats = useMemo(() => {
    let base = channels.filter((c) => !kind || c.kind === kind);
    if (isCountryScoped({ selectedCountry, sidebarPanel }, kind)) {
      base = base.filter((c) => channelCountry(c) === selectedCountry);
    }
    return selectCategoriesFor(base);
  }, [channels, kind, selectedCountry, sidebarPanel]);

  const scrollerRef = useRef(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  const update = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setAtStart(scrollLeft <= 1);
    setAtEnd(scrollLeft + clientWidth >= scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [update, cats.length]);

  const scrollByDir = (dir) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' });
  };

  if (cats.length <= 1) return null;

  return (
    <div className="relative">
      {/* Left arrow + fade (desktop, only when scrolled) */}
      {!atStart && (
        <>
          <div className="pointer-events-none absolute left-0 top-0 bottom-2 w-12 bg-gradient-to-r from-background to-transparent z-10" />
          <button
            type="button"
            onClick={() => scrollByDir(-1)}
            aria-label="Scroll categories left"
            className="hidden md:flex absolute left-0 top-[calc(50%-4px)] -translate-y-1/2 z-20 w-8 h-8 items-center justify-center rounded-full glass hover:bg-white/10 text-on-surface transition-colors"
          >
            <Icon name="chevron_left" className="text-xl" />
          </button>
        </>
      )}

      <div
        ref={scrollerRef}
        className="flex gap-2 overflow-x-auto no-scrollbar pb-2 scroll-smooth"
        style={{ WebkitOverflowScrolling: 'touch', scrollSnapType: 'x proximity' }}
      >
        {cats.map(([name, count]) => (
          <button
            key={name}
            onClick={() => setCategory(name)}
            style={{ scrollSnapAlign: 'start' }}
            className={`shrink-0 px-3 py-1.5 rounded-full text-sm border transition-colors ${
              active === name
                ? 'bg-primary text-on-primary border-primary'
                : 'border-white/10 text-on-surface-variant hover:text-on-surface hover:border-white/30'
            }`}
          >
            {name} <span className="opacity-60">{count}</span>
          </button>
        ))}
      </div>

      {/* Right arrow + fade (desktop, only when more to scroll) */}
      {!atEnd && (
        <>
          <div className="pointer-events-none absolute right-0 top-0 bottom-2 w-12 bg-gradient-to-l from-background to-transparent z-10" />
          <button
            type="button"
            onClick={() => scrollByDir(1)}
            aria-label="Scroll categories right"
            className="hidden md:flex absolute right-0 top-[calc(50%-4px)] -translate-y-1/2 z-20 w-8 h-8 items-center justify-center rounded-full glass hover:bg-white/10 text-on-surface transition-colors"
          >
            <Icon name="chevron_right" className="text-xl" />
          </button>
        </>
      )}
    </div>
  );
}
