import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import Icon from './Icon';

// Shared by the full player and its compact presentation: one mounted listener.
export default function PreviousChannelButton() {
  const ref = useRef(null);
  const previousId = useStore(s => s.previousChannelId);
  const previous = useStore(s => s.channels.find(channel => channel.id === s.previousChannelId));
  const shortcut = useStore(s => s.previousChannelShortcut);
  const toggle = useStore(s => s.playPreviousChannel);
  useEffect(() => {
    const onKey = event => {
      const player = ref.current?.closest('[data-channel-player]');
      if (!shortcut || !previousId || event.defaultPrevented || event.repeat || event.isComposing ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
          document.querySelector('dialog[open]') || !player?.contains(event.target) ||
          event.target.closest('input,textarea,select,button,a,summary,audio,video,[contenteditable]:not([contenteditable=false]),[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=textbox],[role=combobox],[role=slider],[role=menuitem],[role=tab]')) return;
      if (event.key.toLowerCase() === shortcut) { event.preventDefault(); toggle(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previousId, shortcut, toggle]);
  const description = previousId ? previous?.name || 'unavailable' : 'play another channel first';
  return <button ref={ref} type="button" data-no-drag onClick={toggle} disabled={!previousId}
    aria-label={`Previous channel: ${description}`} aria-keyshortcuts={shortcut || undefined}
    title={`Previous channel: ${description}${shortcut ? ` (${shortcut.toUpperCase()})` : ''}`}
    className="min-w-11 min-h-11 shrink-0 inline-flex items-center justify-center hover:text-primary disabled:opacity-40">
    <Icon aria-hidden="true" name="swap_horiz" />
  </button>;
}
