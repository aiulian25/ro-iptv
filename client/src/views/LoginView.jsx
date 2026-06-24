import { useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import Icon from '../components/Icon';
import BrandMark from '../components/BrandMark';

export default function LoginView() {
  const login = useStore((s) => s.login);
  const userRef = useRef(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      await login(username.trim(), password, remember);
    } catch (err) {
      setError(err.message || 'Login failed');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex flex-col md:flex-row bg-background">
      {/* Brand panel — full height on desktop, a hero band on mobile */}
      <div className="relative flex items-center justify-center h-48 md:h-auto md:w-1/2 overflow-hidden bg-gradient-to-br from-[#0D0F1A] via-[#15132e] to-[#0a0a16]">
        {/* subtle grid wash */}
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

      {/* Form panel */}
      <div className="flex-1 md:w-1/2 flex items-center justify-center bg-[#101220] md:border-l md:border-white/5 px-6 py-10 md:px-12">
        <form onSubmit={handleSubmit} className="w-full max-w-sm" noValidate>
          <h1 className="text-3xl md:text-4xl font-extrabold text-on-surface mb-8">Login Here!</h1>

          {error && (
            <div role="alert" className="mb-4 text-sm text-error bg-error/10 border border-error/30 rounded-xl px-4 py-2">
              {error}
            </div>
          )}

          {/* Username */}
          <label htmlFor="login-username" className="sr-only">
            Username
          </label>
          <div className="flex items-center gap-3 mb-4">
            <Icon name="person" className="text-on-surface-variant text-2xl shrink-0" />
            <input
              id="login-username"
              ref={userRef}
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              className="flex-1 rounded-full bg-white/5 border border-white/10 text-on-surface placeholder:text-on-surface-variant/60 px-5 py-3 outline-none focus:ring-2 focus:ring-primary focus:border-primary/40 transition"
            />
          </div>

          {/* Password */}
          <label htmlFor="login-password" className="sr-only">
            Password
          </label>
          <div className="flex items-center gap-3 mb-5">
            <Icon name="lock" className="text-on-surface-variant text-2xl shrink-0" />
            <div className="flex-1 relative">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="password"
                className="w-full rounded-full bg-white/5 border border-white/10 text-on-surface placeholder:text-on-surface-variant/60 px-5 py-3 pr-12 outline-none focus:ring-2 focus:ring-primary focus:border-primary/40 transition"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"
              >
                <Icon name={showPassword ? 'visibility_off' : 'visibility'} className="text-xl" />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between mb-6">
            <label className="flex items-center gap-2 text-sm text-on-surface-variant select-none cursor-pointer">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="w-4 h-4 rounded accent-primary"
              />
              Remember Password
            </label>

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-full bg-primary text-on-primary font-semibold px-7 py-3 hover:scale-105 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed transition-transform shadow-lg shadow-primary/20"
            >
              {submitting ? 'Signing in…' : 'LOGIN'}
              {!submitting && <Icon name="arrow_forward" className="text-lg" />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
