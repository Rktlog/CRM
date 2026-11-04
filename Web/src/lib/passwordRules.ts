// The rules and the plain-English messages for changing a password. Pure (no network), so it can be tested on its own.

export const MIN_PASSWORD_LENGTH = 10;
// The sign-in service keeps a password with bcrypt, which only reads the first 72 BYTES: a longer one would be silently cut short, so it is refused instead.
export const MAX_PASSWORD_BYTES = 72;
const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** The first thing wrong with what was typed, in words a person can act on, or null when it is fine to try. Nothing is sent anywhere before this passes. */
export function checkNewPassword(current: string, next: string, again: string): string | null {
  if (!current) return 'Type your current password.';
  if (next.length < MIN_PASSWORD_LENGTH) return `Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (byteLength(next) > MAX_PASSWORD_BYTES) return 'Your new password is too long. Use 72 characters or fewer (some symbols count as more than one).';
  if (again !== next) return "The two new passwords don't match.";
  if (next === current) return 'Your new password must be different from your current one.';
  return null;
}

type AuthError = { message?: string; code?: string; status?: number; name?: string; reasons?: string[] } | null | undefined;
const text = (e: AuthError) => String(e?.message ?? '');
const isRateLimit = (e: AuthError) => e?.status === 429 || e?.code === 'over_request_rate_limit' || /rate limit|too many/i.test(text(e));
const isNetwork = (e: AuthError) => e?.name === 'AuthRetryableFetchError' || /failed to fetch|network|fetch failed|timed? ?out/i.test(text(e)) || (e?.status === 0);

/** What went wrong, in plain words. `step` is which of the two calls failed: checking the current password, or saving the new one. */
export function explainAuthError(step: 'verify' | 'update', e: AuthError): string {
  if (isRateLimit(e)) return 'Too many attempts. Wait a minute, then try again.';
  if (isNetwork(e)) return "Couldn't reach the sign-in service. Check your connection and try again.";
  if (step === 'verify') {
    if (e?.code === 'invalid_credentials' || /invalid login credentials/i.test(text(e))) return 'Your current password is wrong.';
    if (/email not confirmed/i.test(text(e))) return "This account hasn't been confirmed yet. Ask a manager to resend the invite.";
    return `Couldn't check your current password: ${text(e) || 'unknown problem'}`;
  }
  if (e?.code === 'weak_password' || /weak|easy to guess|should contain/i.test(text(e))) {
    const reasons = e?.reasons ?? [];
    if (reasons.includes('pwned')) return 'That password has turned up in known data leaks. Choose a different one.';
    if (reasons.includes('length')) return `That password is too short for the sign-in service. Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (reasons.includes('characters')) return 'That password needs a mix of capital and small letters and numbers.';
    return 'That password is too easy to guess. Choose a different one.';
  }
  if (e?.code === 'same_password' || /different from the old password|same as the old/i.test(text(e))) return 'Your new password must be different from your current one.';
  if (e?.code === 'reauthentication_needed' || /reauthenticat/i.test(text(e))) return 'For safety, sign out, sign in again, and then change your password.';
  return `Couldn't change the password: ${text(e) || 'unknown problem'}`;
}
