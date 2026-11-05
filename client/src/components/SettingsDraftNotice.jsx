import { useEffect } from 'react';
import { useStore, hasSettingsDraft } from '../store/useStore';

// Draft ownership outlives the Settings page. The browser-close warning therefore
// also stays active after internal navigation; it never writes private form data.
export default function SettingsDraftNotice() {
  const editor = useStore(s => s.settingsDraft);
  const settings = useStore(s => s.settings);
  const view = useStore(s => s.view);
  const setView = useStore(s => s.setView);
  const dirty = hasSettingsDraft(editor, settings);
  useEffect(() => {
    if (!dirty) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  if (!dirty || view === 'settings') return null;
  return (
    <div role="status" className="fixed bottom-4 left-4 z-40 max-w-[calc(100vw-2rem)] glass-dark rounded-xl p-3 flex flex-wrap items-center gap-3 text-sm">
      <span>Unsaved Settings draft kept.</span>
      <button onClick={() => setView('settings')} className="text-primary underline">Return to Settings</button>
    </div>
  );
}
