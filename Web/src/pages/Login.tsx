import { useState, FormEvent } from 'react';
import { supabase } from '../lib/supabase';

// Sign-in for the Rhino Rhino sales team. The brand name is the one bold
// element: two stacked words, the second an outlined echo of the first.
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      setError(/invalid login credentials/i.test(error.message)
        ? "That email and password don't match. Check them and try again."
        : /email not confirmed/i.test(error.message)
          ? 'This account hasn\u2019t been confirmed yet. Ask a manager to resend the invite.'
          : error.message);
    }
  }

  return (
    <main className="signin">
      <section className="signin-brand" aria-label="Rhino Rhino">
        <div className="signin-mark" aria-hidden="true">
          <span>Rhino</span>
          <span>Rhino</span>
        </div>
        <p className="signin-about">
          Accounts, orders, visits and stock for the Rhino Rhino sales team.
        </p>
      </section>

      <section className="signin-panel">
        <form className="signin-form" onSubmit={handleSubmit} noValidate={false}>
          <h1>Sign in</h1>
          <p className="signin-sub">Use your @rhinorhino.com.au email.</p>

          <label className="signin-field">
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>

          <label className="signin-field">
            <span>Password</span>
            <span className="signin-password">
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="signin-show"
                onClick={() => setShowPassword(v => !v)}
                aria-pressed={showPassword}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </span>
          </label>

          {error && <div className="signin-error" role="alert">{error}</div>}

          <button className="signin-submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="signin-help">Forgotten your password? Ask a manager to reset it.</p>
        </form>
      </section>
    </main>
  );
}