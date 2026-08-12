import { useState } from 'react';
import { useStore } from '../store/useStore';
import { programmesForChannel, fmtTime, epgIconFor } from '../lib/epg';
import { supportsCatchup } from '../lib/catchup';
import ChannelLogo from './ChannelLogo';
import Icon from './Icon';

const MS_PER_DAY = 86_400_000;

// Group programmes under day headings (weekday + date), preserving input order.
function groupByDay(programmes) {
  const groups = new Map();
  for (const p of programmes) {
    const day = new Date(p.start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(p);
  }
  return [...groups.entries()];
}

// Archive browser: catchup-capable channels, each expanding to its past
// programmes (grouped by day) with a Play button that streams the archive.
export default function CatchupPanel({ channels, epg }) {
  const overrides = useStore((s) => s.settings.epgOverrides || {});
  const playCatchup = useStore((s) => s.playCatchup);
  const [expandedId, setExpandedId] = useState(null);

  const archived = channels.filter(supportsCatchup);

  if (!archived.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant gap-3 text-center px-6">
        <Icon name="replay" className="text-5xl opacity-60" />
        <p>No catchup channels.</p>
        <p className="text-sm">
          Catchup needs <code>catchup=</code> attributes in your playlist.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {archived.map((c) => {
        const isOpen = expandedId === c.id;
        const days = c.catchupDays || 1;
        const cutoff = Date.now() - days * MS_PER_DAY;
        const past = isOpen
          ? programmesForChannel(epg, c, overrides)
              .filter((p) => Date.parse(p.stop) < Date.now() && Date.parse(p.start) > cutoff)
              .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
          : [];

        return (
          <div key={c.id} className="glass rounded-xl p-3">
            <button
              onClick={() => setExpandedId(isOpen ? null : c.id)}
              aria-expanded={isOpen}
              className="flex items-center gap-3 w-full text-left"
            >
              <ChannelLogo src={c.logo || epgIconFor(epg, c)} kind={c.kind} className="w-12 h-9" />
              <h3 className="flex-1 min-w-0 font-semibold truncate">{c.name}</h3>
              <span className="shrink-0 text-xs glass rounded-full px-3 py-1">{days} days</span>
              <Icon name={isOpen ? 'expand_less' : 'expand_more'} className="text-on-surface-variant shrink-0" />
            </button>

            {isOpen && (
              <div className="mt-3 flex flex-col gap-3">
                {past.length ? (
                  groupByDay(past).map(([day, progs]) => (
                    <div key={day}>
                      <p className="font-mono text-[11px] uppercase text-on-surface-variant mb-1">{day}</p>
                      <div className="flex flex-col">
                        {progs.map((p, i) => (
                          <div key={i} className="flex items-center gap-3 py-1.5 border-t border-white/5 first:border-0">
                            <span className="font-mono text-[11px] text-on-surface-variant shrink-0 w-24">
                              {fmtTime(p.start)}–{fmtTime(p.stop)}
                            </span>
                            <span className="flex-1 min-w-0 truncate text-sm">{p.title}</span>
                            <button
                              onClick={() => playCatchup(c, p)}
                              className="shrink-0 text-primary hover:text-white transition-colors"
                              aria-label={`Play ${p.title}`}
                            >
                              <Icon name="play_circle" fill className="text-2xl" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-on-surface-variant py-2">No archived programmes in the last {days} days.</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
