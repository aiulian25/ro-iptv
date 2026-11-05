import { useStore } from '../store/useStore';
import Icon from './Icon';

import { panelsForView } from '../lib/mediaPanels';

// Collapsed icon rail that expands to labels on hover (matches Luxe design).
export default function IconSidebar() {
  const panel = useStore((s) => s.sidebarPanel);
  const view = useStore((s) => s.view);
  const selectedCountry = useStore((s) => s.selectedCountry);
  const setPanel = useStore((s) => s.setSidebarPanel);
  const items = panelsForView(view);
  if (!items.length) return null;

  return (
    <aside aria-label={`${view === 'radio' ? 'Radio' : 'Live TV'} browsing`} className="group hidden md:flex fixed left-0 top-0 bottom-0 z-30 w-20 hover:w-56 transition-[width] duration-300 bg-surface/60 backdrop-blur-2xl border-r border-white/10 flex-col items-stretch pt-28 pb-6 gap-2 px-3 overflow-hidden">
      {items.map((it) => {
        const active =
          it.id === 'countries'
            ? view === 'live' && selectedCountry === null && panel === 'channels'
            : panel === it.id && !(view === 'live' && it.id === 'channels' && selectedCountry === null);
        return (
          <button
            key={it.id}
            onClick={() => setPanel(it.id)}
            aria-label={it.label}
            aria-pressed={active}
            className={`flex items-center gap-4 rounded-xl px-3.5 py-3 transition-all duration-200 ${
              active
                ? 'bg-primary-container text-on-primary-container shadow-[0_0_20px_rgba(128,131,255,0.4)]'
                : 'text-on-surface-variant hover:bg-surface-variant/50'
            }`}
          >
            <Icon aria-hidden="true" name={it.icon} fill={active} className="text-2xl shrink-0" />
            <span className="whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-base">
              {it.label}
            </span>
          </button>
        );
      })}
    </aside>
  );
}
