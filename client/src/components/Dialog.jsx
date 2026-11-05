import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

// Native modal top-layer supplies background inertness. Focus guards keep Tab
// inside the dialog while preserving native media controls' internal tab order.
// Keep React as the owner of open/close state and restore the invoking control.
export default function Dialog({ label, onClose, className = '', maxWidth = '32rem', children }) {
  const ref = useRef(null);
  const focusEdge = (last) => {
    const controls = [...ref.current.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), video[controls], audio[controls], [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hasAttribute('data-focus-guard') && el.getClientRects().length && !el.closest('[inert]'));
    (last ? controls.at(-1) : controls[0])?.focus();
  };
  useLayoutEffect(() => {
    const dialog = ref.current, opener = document.activeElement;
    dialog.showModal();
    focusEdge(false);
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog ref={ref} aria-label={label} aria-modal="true"
      className={`app-dialog border-0 p-0 bg-transparent text-on-surface max-h-[90dvh] ${className}`}
      style={{ width: 'calc(100vw - 2rem)', maxWidth }}
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const box = event.currentTarget.getBoundingClientRect();
        if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
      }}
    >
      <span tabIndex={0} data-focus-guard="" className="sr-only" onFocus={() => focusEdge(true)} />
      {children}
      <span tabIndex={0} data-focus-guard="" className="sr-only" onFocus={() => focusEdge(false)} />
    </dialog>, document.body
  );
}
