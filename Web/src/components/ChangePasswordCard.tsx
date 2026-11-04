import { useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { checkNewPassword, explainAuthError, MIN_PASSWORD_LENGTH } from '../lib/passwordRules';

// Settings: a person changes their own password. They type the current one (checked by signing in with it again, so a computer left unlocked cannot change it),
// then the new one twice. Nothing is sent anywhere until what they typed passes the checks in lib/passwordRules.ts. The password is never logged or kept: the
// boxes are cleared as soon as it is saved. When it is saved, every OTHER place they are signed in (another computer, a phone) is signed out; this one stays.
const field: CSSProperties = { width: '100%', maxWidth: 360, padding: '6px 9px', border: '1px solid var(--line)', borderRadius: 3, fontSize: 14 };
const label: CSSProperties = { display: 'grid', gap: 4, fontSize: 13 };

export default function ChangePasswordCard() {
  const { session } = useAuth();
  const email = session?.user?.email ?? '';
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const working = useRef(false);   // a second click, or Enter pressed twice, while it is working does nothing

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (working.current) return;
    setMsg(null);
    const problem = checkNewPassword(current, next, again);
    if (problem) { setMsg({ ok: false, text: problem }); return; }
    if (!email) { setMsg({ ok: false, text: "Couldn't find your email address. Sign out, sign in again, and then try again." }); return; }
    working.current = true;
    setBusy(true);
    try {
      // 1. The current password is checked by signing in with it.
      const check = await supabase.auth.signInWithPassword({ email, password: current });
      if (check.error) { setMsg({ ok: false, text: explainAuthError('verify', check.error) }); return; }
      // 2. The new one is saved.
      const saved = await supabase.auth.updateUser({ password: next });
      if (saved.error) { setMsg({ ok: false, text: explainAuthError('update', saved.error) }); return; }
      setCurrent(''); setNext(''); setAgain(''); setShow(false);
      // 3. Anywhere else this person is signed in is signed out; this computer stays signed in.
      let others = true;
      try { const out = await supabase.auth.signOut({ scope: 'others' }); if (out.error) others = false; } catch { others = false; }
      setMsg({
        ok: true,
        text: others
          ? 'Your password has been changed. You are still signed in here, and your other devices have been signed out.'
          : "Your password has been changed. You are still signed in here. We couldn't sign out your other devices: if you think someone else knows your old password, sign out on them yourself.",
      });
    } catch (err) {
      setMsg({ ok: false, text: explainAuthError('update', err as { message?: string }) });
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';
  return (
    <div className="section" id="change-password">
      <div className="panel-title">Change my password</div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14, maxWidth: 560 }}>
        Type your current password, then your new one twice. You stay signed in on this computer. Anywhere else you are signed in, such as another computer or a phone, is signed out.
      </div>
      <form onSubmit={submit} noValidate style={{ display: 'grid', gap: 12, maxWidth: 380 }}>
        {/* so a password manager knows whose password this is and updates the saved one */}
        <input type="text" name="username" autoComplete="username" value={email} readOnly tabIndex={-1} aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 }} />
        <label style={label}>
          Current password
          <input type={type} name="current-password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} disabled={busy} style={field} />
        </label>
        <label style={label}>
          New password
          <input type={type} name="new-password" autoComplete="new-password" aria-describedby="new-password-hint" value={next} onChange={e => setNext(e.target.value)} disabled={busy} style={field} />
          <span id="new-password-hint" style={{ fontSize: 12, color: 'var(--muted)' }}>
            At least {MIN_PASSWORD_LENGTH} characters. A few unrelated words together are easy to remember and hard to guess.
          </span>
        </label>
        <label style={label}>
          New password again
          <input type={type} name="confirm-new-password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} disabled={busy} style={field} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} /> Show passwords
        </label>
        <div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button>
        </div>
        {msg && <div className={msg.ok ? 'save-msg ok' : 'save-msg err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      </form>
    </div>
  );
}
