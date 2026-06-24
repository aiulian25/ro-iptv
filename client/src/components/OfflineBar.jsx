import { useEffect, useState } from 'react';
import Icon from './Icon';

// Slim banner shown when the browser goes offline (streams unavailable).
export default function OfflineBar() {
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="fixed top-0 inset-x-0 z-[80] bg-error/90 text-on-error text-sm font-medium py-1.5 flex items-center justify-center gap-2">
      <Icon name="wifi_off" className="text-base" />
      You're offline — live streams are unavailable. Cached data is still browsable.
    </div>
  );
}
