import { useState } from 'react';
import { useStore } from '../store/useStore';
import Icon from './Icon';

// "Account" section for the Settings page — voluntary password change. Only
// rendered when authentication is enabled and the user is signed in.
export default function PasswordSettings() {
  const enabled = useStore((s) => s.auth.required && s.auth.authed);
  const username = useStore((s) => s.auth.username);
  const updatePassword = useStore((s) => s.updatePassword);
  const setToast = useStore((s) => s.setToast);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!enabled) return null;

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (next.length < 8) return setError('New password must be at least 8 characters.');
    if (next !== confirm) return setError('New passwords do not match.');
    if (next === current) return setError('New password must differ from the current one.');
    setBusy(true);
    try {
      await updatePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setToast('Password updated');
    } catch (err) {
      setError(err.message || 'Could not update password');
    } finally {
      setBusy(false);
    }
  };

  const field = 'glass rounded-xl px-4 py-3 outline-none focus:ring-1 focus:ring-primary';

  return (
    <section className="glass rounded-2xl p-5 md:p-6">
      <h2 className="text-lg font-semibold text-primary mb-1 flex items-center gap-2">
        <Icon name="lock" /> Account
      </h2>
      <p className="text-sm text-on-surface-variant mb-4">
        Change the password for <span className="font-medium text-on-surface">{username || 'your account'}</span>.
      </p>

      <form onSubmit={submit} className="flex flex-col gap-3 max-w-md" noValidate>
        {error && (
          <div role="alert" className="text-sm text-error bg-error/10 border border-error/30 rounded-xl px-3 py-2">
            {error}
          </div>
        )}

        <label className="sr-only" htmlFor="cur-pass">Current password</label>
        <input
          id="cur-pass"
          type={show ? 'text' : 'password'}
          autoComplete="current-password"
          placeholder="Current password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={field}
          required
        />

        <label className="sr-only" htmlFor="new-pass">New password</label>
        <input
          id="new-pass"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="New password (min 8 characters)"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={field}
          required
        />

        <label className="sr-only" htmlFor="confirm-pass">Confirm new password</label>
        <input
          id="confirm-pass"
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="Confirm new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={field}
          required
        />

        <label className="flex items-center gap-2 text-sm text-on-surface-variant select-none cursor-pointer">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="w-4 h-4 rounded" />
          Show passwords
        </label>

        <button
          type="submit"
          disabled={busy}
          className="self-start bg-primary text-on-primary px-5 py-2.5 rounded-xl font-medium hover:scale-105 transition-transform disabled:opacity-50"
        >
          {busy ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </section>
  );
}
