import { useStore } from '../store/useStore';
import { ITEMS } from './IconSidebar';
import Icon from './Icon';

// Mobile counterpart of the desktop icon rail: a horizontally scrollable strip
// of panel pills shown under the Live TV header (hidden at md+).
export default function MobilePanelBar() {
  const panel = useStore((s) => s.sidebarPanel);
  const view = useStore((s) => s.view);
  const selectedCountry = useStore((s) => s.selectedCountry);
  const setPanel = useStore((s) => s.setSidebarPanel);
  const setView = useStore((s) => s.setView);
  const setSelectedCountry = useStore((s) => s.setSelectedCountry);

  // "Countries" jumps to the Live TV country grid (overriding any default country).
  const openCountries = () => {
    setView('live');
    setSelectedCountry(null);
  };

  return (
    <div className="md:hidden flex gap-2 overflow-x-auto no-scrollbar pb-1">
      {ITEMS.map((it) => {
        const active =
          it.id === 'countries'
            ? view === 'live' && selectedCountry === null && panel === 'channels'
            : panel === it.id;
        return (
          <button
            key={it.id}
            onClick={() => (it.id === 'countries' ? openCountries() : setPanel(it.id))}
            className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition-colors ${
              active
                ? 'bg-primary text-on-primary border-primary'
                : 'border-white/10 text-on-surface-variant hover:text-on-surface hover:border-white/30'
            }`}
          >
            <Icon name={it.icon} fill={active} className="text-base" />
            <span className="whitespace-nowrap">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}
