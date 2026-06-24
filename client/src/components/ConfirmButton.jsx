import { useState } from 'react';
import Icon from './Icon';

// Two-step confirm for a destructive action — click arms it, then Confirm/Cancel.
// Keeps everything inline (no modal) and keyboard-accessible.
export default function ConfirmButton({ label, confirmLabel = 'Yes, delete', icon = 'delete_forever', onConfirm, disabled }) {
  const [armed, setArmed] = useState(false);

  if (disabled) {
    return (
      <button
        disabled
        className="w-full glass rounded-xl px-4 py-3 flex items-center justify-center gap-2 text-on-surface-variant/50 cursor-not-allowed"
      >
        <Icon name={icon} /> {label}
      </button>
    );
  }

  if (!armed) {
    return (
      <button
        onClick={() => setArmed(true)}
        className="w-full rounded-xl px-4 py-3 flex items-center justify-center gap-2 border border-error/40 text-error hover:bg-error/10 transition-colors"
      >
        <Icon name={icon} /> {label}
      </button>
    );
  }

  return (
    <div className="w-full rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 border border-error/60 bg-error/10">
      <span className="text-sm text-on-surface">This can’t be undone. Continue?</span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => setArmed(false)}
          className="px-3 py-1.5 rounded-full text-sm hover:bg-white/10 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            onConfirm();
            setArmed(false);
          }}
          className="px-3 py-1.5 rounded-full text-sm font-semibold bg-error text-on-error hover:brightness-110 transition"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
