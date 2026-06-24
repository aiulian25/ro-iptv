import { useStore } from '../store/useStore';
import Icon from './Icon';

const TABS = [
  { id: 'live', label: 'Live TV' },
  { id: 'radio', label: 'Radio' },
  { id: 'recordings', label: 'Recordings' },
];

export default function TopNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const auth = useStore((s) => s.auth);
  const logout = useStore((s) => s.logout);

  return (
    <header className="fixed top-0 inset-x-0 z-40 backdrop-blur-xl bg-background/50 border-b border-white/5 flex flex-wrap gap-y-3 justify-between items-center px-4 md:px-10 py-3 md:py-4">
      <div className="flex items-center gap-6 md:gap-12">
        <button onClick={() => setView('home')} className="flex items-center gap-2 group">
          <Icon name="smart_display" fill className="text-primary text-3xl" />
          <span className="text-xl md:text-2xl font-bold text-primary tracking-tight">RO-IPTV</span>
        </button>
        <nav className="hidden md:flex gap-6 lg:gap-8">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              className={`text-base lg:text-lg transition-transform hover:scale-105 pb-1 ${
                view === t.id
                  ? 'text-primary border-b-2 border-primary font-semibold'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-3 md:gap-5">
        <div className="glass px-4 py-2 rounded-full flex items-center gap-2">
          <Icon name="search" className="text-primary text-xl" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent border-none outline-none text-sm md:text-base w-28 md:w-48 text-on-surface placeholder:text-on-surface-variant/60"
            placeholder="Search channels..."
          />
        </div>
        <button
          onClick={() => setView('settings')}
          className={`transition-colors ${
            view === 'settings' ? 'text-primary' : 'text-on-surface-variant hover:text-primary'
          }`}
          aria-label="Settings"
          aria-current={view === 'settings' ? 'page' : undefined}
        >
          <Icon name="settings" fill={view === 'settings'} className="text-2xl md:text-3xl" />
        </button>
        {auth.required && auth.authed && (
          <button
            onClick={logout}
            className="text-on-surface-variant hover:text-primary transition-colors"
            aria-label="Sign out"
            title="Sign out"
          >
            <Icon name="logout" className="text-2xl md:text-3xl" />
          </button>
        )}
      </div>

      {/* Mobile tab bar */}
      <nav className="md:hidden w-full flex justify-between gap-1 overflow-x-auto no-scrollbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setView(t.id)}
            className={`text-xs px-3 py-1 rounded-full whitespace-nowrap ${
              view === t.id ? 'bg-primary-container text-on-primary-container' : 'text-on-surface-variant'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
