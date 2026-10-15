// When the next delivery should arrive, for reps to tell customers.
// Set by hand wins over the date on the incoming order in DEAR. Late (past its date, still on order) shows in red.
export type Eta = { date: string | null; source: 'manual' | 'po'; ref: string | null; qty: number; late: boolean } | null | undefined;

const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: new Date(`${iso}T00:00:00`).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });

export default function EtaText({ eta, block }: { eta: Eta; block?: boolean }) {
  if (!eta) return null;
  const from = eta.source === 'manual' ? 'Date set by hand' : eta.ref ? `From incoming order ${eta.ref}` : 'From an incoming order';
  const text = eta.date ? (eta.late ? `Was due ${fmt(eta.date)}` : `ETA ${fmt(eta.date)}`) : 'On order, no date yet';
  return (
    <span className="acct-region" title={`${from}${eta.qty ? `, ${eta.qty.toLocaleString('en-AU')} coming` : ''}`}
      style={{ display: block ? 'block' : 'inline', fontWeight: 600, color: eta.late ? 'var(--rust)' : eta.date ? 'var(--teal)' : 'var(--muted)' }}>
      {text}
    </span>
  );
}