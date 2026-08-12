import { useEffect } from 'react';
import { useStore } from './store/useStore';
import TopNav from './components/TopNav';
import IconSidebar from './components/IconSidebar';
import Toast from './components/Toast';
import InstallPrompt from './components/InstallPrompt';
import OfflineBar from './components/OfflineBar';
import MiniPlayer from './components/MiniPlayer';
import { clearNowPlaying } from './hooks/useMediaSession';
import HomeView from './views/HomeView';
import LiveView from './views/LiveView';
import RadioView from './views/RadioView';
import RecordingsView from './views/RecordingsView';
import SettingsPage from './views/SettingsPage';
import LoginView from './views/LoginView';
import ChangePasswordView from './views/ChangePasswordView';

export default function App() {
  const view = useStore((s) => s.view);
  const auth = useStore((s) => s.auth);
  const checkAuth = useStore((s) => s.checkAuth);
  const init = useStore((s) => s.init);
  const restoreLastChannel = useStore((s) => s.restoreLastChannel);
  const refreshAllPlaylists = useStore((s) => s.refreshAllPlaylists);
  const loadEpg = useStore((s) => s.loadEpg);
  const refreshIntervalMinutes = useStore((s) => s.settings.refreshIntervalMinutes);
  const currentChannel = useStore((s) => s.currentChannel);

  // Gate startup on auth: only load app data once we know we're signed in
  // (or that auth isn't required). Login itself triggers init() on success.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const a = await checkAuth();
      if (cancelled) return;
      if (!a.required || a.authed) {
        init();
        restoreLastChannel();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkAuth, init, restoreLastChannel]);

  // Clear the OS now-playing card when playback is stopped entirely.
  useEffect(() => {
    if (!currentChannel) clearNowPlaying();
  }, [currentChannel]);

  // Background auto-refresh of all URL playlists and the EPG guide (same cadence,
  // so Now/Next doesn't go stale during a long session).
  useEffect(() => {
    if (!refreshIntervalMinutes) return;
    const id = setInterval(() => {
      refreshAllPlaylists();
      loadEpg();
    }, refreshIntervalMinutes * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshIntervalMinutes, refreshAllPlaylists, loadEpg]);

  // While we don't yet know the auth state, show a minimal splash (avoids a
  // flash of either the app or the login screen).
  if (!auth.checked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-10 h-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      </div>
    );
  }

  // Auth required but no valid session → the login page owns the screen.
  if (auth.required && !auth.authed) {
    return <LoginView />;
  }

  // Signed in with the bootstrap password → force a change before the app loads.
  if (auth.required && auth.authed && auth.mustChange) {
    return <ChangePasswordView />;
  }

  // The left icon rail is for channel browsing — hide it on Home and Settings.
  const showChrome = view !== 'home' && view !== 'settings';

  return (
    <div className="min-h-screen">
      <TopNav />
      {showChrome && <IconSidebar />}

      <main>
        {view === 'home' && <HomeView />}
        {view === 'live' && <LiveView />}
        {view === 'radio' && <RadioView />}
        {view === 'recordings' && <RecordingsView />}
        {view === 'settings' && <SettingsPage />}
      </main>

      <MiniPlayer />
      <OfflineBar />
      <Toast />
      <InstallPrompt />
    </div>
  );
}
