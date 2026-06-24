import { useEffect, useState } from 'react';
import Icon from './Icon';

// "Add to Home Screen" prompt shown on first eligible visit.
export default function InstallPrompt() {
  const [deferred, setDeferred] = useState(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem('ro-iptv:install-dismissed')) return;
    const handler = (e) => {
      e.preventDefault();
      setDeferred(e);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const dismiss = () => {
    setVisible(false);
    localStorage.setItem('ro-iptv:install-dismissed', '1');
  };

  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    dismiss();
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-6 left-6 z-[70] glass-dark rounded-2xl p-4 flex items-center gap-4 max-w-sm animate-fade-in shadow-2xl">
      <Icon name="install_mobile" className="text-primary text-3xl" />
      <div className="flex-1">
        <p className="font-semibold">Install RO-IPTV</p>
        <p className="text-sm text-on-surface-variant">Add to your home screen for a full-screen app experience.</p>
      </div>
      <div className="flex flex-col gap-1">
        <button onClick={install} className="bg-primary text-on-primary px-4 py-1.5 rounded-full text-sm font-medium">
          Install
        </button>
        <button onClick={dismiss} className="text-on-surface-variant text-xs hover:text-on-surface">
          Not now
        </button>
      </div>
    </div>
  );
}
