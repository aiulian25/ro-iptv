import { useState } from 'react';
import { useStore } from '../store/useStore';
import Icon from '../components/Icon';
import BrandMark from '../components/BrandMark';

// Forced first-login password change. Shown after a bootstrap (admin/admin)
// login until a real password is set — the default credential is then retired.
export default function ChangePasswordView() {
  const changePassword = useStore((s) => s.changePassword);
  const username = useStore((s) => s.auth.username);
  const logout = useStore((s) => s.logout);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setError('');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('Passwords do not match.');
    setSubmitting(true);
    try {
      await changePassword(password, true);
    } catch (err) {
      setError(err.message || 'Could not set password');
      setSubmitting(false);
    }
  };

  const field =
    'w-full rounded-full bg-white/5 border border-white/10 text-on-surface placeholder:text-on-surface-variant/60 px-5 py-3 pr-12 outline-none focus:ring-2 focus:ring-primary focus:border-primary/40 transition';

  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row bg-background">
      <div className="relative flex items-center justify-center h-48 md:h-auto md:w-1/2 overflow-hidden bg-gradient-to-br from-[#0D0F1A] via-[#15132e] to-[#0a0a16]">
        <div
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(124,92,255,0.25) 1px, transparent 1px), linear-gradient(90deg, rgba(124,92,255,0.25) 1px, transparent 1px)',
            backgroundSize: '38px 38px',
          }}
        />
        <BrandMark className="relative w-28 h-28 md:w-52 md:h-52 drop-shadow-[0_0_30px_rgba(124,92,255,0.35)]" />
      </div>

      <div className="flex-1 md:w-1/2 flex items-center justify-center bg-[#101220] md:border-l md:border-white/5 px-6 py-10 md:px-12">
        <form onSubmit={handleSubmit} className="w-full max-w-sm" noValidate>
          <h1 className="text-3xl md:text-4xl font-extrabold text-on-surface mb-2">Set a new password</h1>
          <p className="text-on-surface-variant mb-8 text-sm">
            Signed in as <span className="font-semibold text-on-surface">{username || 'admin'}</span>. For security you must
            replace the default password before continuing.
          </p>

          {error && (
            <div role="alert" className="mb-4 text-sm text-error bg-error/10 border border-error/30 rounded-xl px-4 py-2">
              {error}
            </div>
          )}

          <label htmlFor="new-password" className="sr-only">
            New password
          </label>
          <div className="flex items-center gap-3 mb-4">
            <Icon name="lock" className="text-on-surface-variant text-2xl shrink-0" />
            <div className="flex-1 relative">
              <input
                id="new-password"
                type={show ? 'text' : 'password'}
                autoComplete="new-password"
                required
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="new password (min 8 characters)"
                className={field}
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? 'Hide password' : 'Show password'}
                aria-pressed={show}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"
              >
                <Icon name={show ? 'visibility_off' : 'visibility'} className="text-xl" />
              </button>
            </div>
          </div>

          <label htmlFor="confirm-password" className="sr-only">
            Confirm new password
          </label>
          <div className="flex items-center gap-3 mb-6">
            <Icon name="lock_reset" className="text-on-surface-variant text-2xl shrink-0" />
            <input
              id="confirm-password"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="confirm new password"
              className="flex-1 rounded-full bg-white/5 border border-white/10 text-on-surface placeholder:text-on-surface-variant/60 px-5 py-3 outline-none focus:ring-2 focus:ring-primary focus:border-primary/40 transition"
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={logout}
              className="text-sm text-on-surface-variant hover:text-on-surface"
            >
              Sign out
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-full bg-primary text-on-primary font-semibold px-7 py-3 hover:scale-105 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed transition-transform shadow-lg shadow-primary/20"
            >
              {submitting ? 'Saving…' : 'SET PASSWORD'}
              {!submitting && <Icon name="arrow_forward" className="text-lg" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
