import { useState } from 'react';
import { useStore } from '../store/useStore';
import { normalizeName } from '../lib/epg';
import Icon from './Icon';

const MAX_ROWS = 50;

// Manually map a channel to an xmltv guide channel when automatic matching fails.
// The choice persists in settings.epgOverrides and wins over all auto-matching.
export default function EpgLinkButton({ channel }) {
  const epg = useStore((s) => s.epg);
  const overrides = useStore((s) => s.settings.epgOverrides || {});
  const applySettings = useStore((s) => s.applySettings);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  if (!epg || !channel) return null;

  const normalizedQuery = normalizeName(query);
  const matches = Object.entries(epg.channels || {})
    .map(([id, value]) => ({ id, name: typeof value === 'string' ? value : value?.name || '' }))
    .filter(({ id, name }) => !normalizedQuery || normalizeName(name).includes(normalizedQuery) || id.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, MAX_ROWS);

  const currentOverride = overrides[channel.id];

  const link = (xmltvId) => {
    applySettings({ epgOverrides: { ...overrides, [channel.id]: xmltvId } });
    setOpen(false);
  };
  const unlink = () => {
    const next = { ...overrides };
    delete next[channel.id];
    applySettings({ epgOverrides: next });
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        className="glass px-5 py-2.5 rounded-full flex items-center gap-2 hover:bg-white/10 transition-all"
      >
        <Icon name="link" className="text-lg" />
        <span className="font-mono text-xs">Link EPG</span>
      </button>
      {open && (
        <div className="absolute z-40 mt-2 right-0 glass-dark rounded-xl p-2 w-72 max-w-[80vw]">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search guide channels…"
            aria-label="Search guide channels"
            autoFocus
            className="w-full bg-transparent outline-none border border-white/10 rounded-lg px-3 py-2 text-sm mb-2 text-on-surface placeholder:text-on-surface-variant/60"
          />
          <div className="max-h-64 overflow-y-auto scroll-area flex flex-col">
            {currentOverride && (
              <button onClick={unlink} className="text-left px-3 py-1.5 rounded text-sm text-error hover:bg-white/10">
                Unlink
              </button>
            )}
            {matches.length ? (
              matches.map(({ id, name }) => (
                <button
                  key={id}
                  onClick={() => link(id)}
                  className={`text-left px-3 py-1.5 rounded text-sm hover:bg-white/10 truncate ${currentOverride === id ? 'text-primary' : ''}`}
                >
                  {name || id} <span className="text-on-surface-variant/60">({id})</span>
                </button>
              ))
            ) : (
              <p className="px-3 py-2 text-sm text-on-surface-variant">No guide channels match.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
