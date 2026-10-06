import { useEffect, useMemo, useState } from 'react';
import { apiPost } from '../lib/api';
import { Account, STAGE_LABELS, fmtMoney, fmtDateWithYear, findLikelyDuplicates } from '../lib/types';
import { useMe, ALL_STATES } from '../lib/useMe';

// Pick an existing account, or add a new store on the spot. Shared by
// Schedule task and Log a visit so both behave the same way.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NewStore = { name: string; region: string; contactName: string; phone: string; email: string };

// null = nothing usable chosen yet (no account, or a new store missing a
// name or still flagged as a possible duplicate).
export type AccountSelection =
  | { kind: 'existing'; account: Account }
  | { kind: 'new'; store: NewStore }
  | null;

// Turns the selection into a real account: an existing one as-is, or a
// new store saved as a new lead owned by the person adding it.
export async function resolveSelection(sel: Exclude<AccountSelection, null>, repId: string): Promise<{ id: string; name: string }> {
  if (sel.kind === 'existing') return { id: sel.account.id, name: sel.account.name };
  const s = sel.store;
  const created = await apiPost('/accounts', {
    name: s.name.trim(),
    region: s.region,
    credit: 'prepay', // no terms on record yet = Prepayment, until DEAR says otherwise
    repId,
    type: 'prospect',
    contactName: s.contactName.trim() || undefined,
    phone: s.phone.trim() || undefined,
    email: s.email.trim() || undefined,
  });
  return { id: created.id, name: created.name };
}

type Props = {
  accounts: Account[] | null;
  onChange: (sel: AccountSelection) => void;
  autoFocus?: boolean;
};

export default function AccountPicker({ accounts, onChange, autoFocus }: Props) {
  const me = useMe();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Account | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [store, setStore] = useState<NewStore>({ name: '', region: '', contactName: '', phone: '', email: '' });
  const [confirmedNotDuplicate, setConfirmedNotDuplicate] = useState(false);

  // A new store defaults to the person's own state.
  useEffect(() => {
    if (me && !store.region) setStore(s => ({ ...s, region: me.regions[0] ?? 'NSW' }));
  }, [me]);

  const matches = useMemo(() => {
    if (!accounts || selected) return [];
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return accounts.filter(a => a.name.toLowerCase().includes(q)).slice(0, 8);
  }, [accounts, search, selected]);

  const possibleDuplicates = useMemo(
    () => (addingNew ? findLikelyDuplicates(store.name, (accounts ?? []).map(a => a.name)) : []),
    [addingNew, store.name, accounts],
  );

  // A new store needs a way to reach it: a phone number or an email (or
  // both), and an email has to look like one.
  const emailValid = !store.email.trim() || EMAIL_PATTERN.test(store.email.trim());
  const hasContact = store.phone.trim().length > 0 || store.email.trim().length > 0;

  // Tell the parent what's usable whenever anything changes.
  useEffect(() => {
    if (addingNew) {
      const ready = store.name.trim().length > 0
        && hasContact && emailValid
        && (possibleDuplicates.length === 0 || confirmedNotDuplicate);
      onChange(ready ? { kind: 'new', store } : null);
    } else {
      onChange(selected ? { kind: 'existing', account: selected } : null);
    }
  }, [addingNew, store, selected, possibleDuplicates.length, confirmedNotDuplicate, hasContact, emailValid]);

  // States a new store can go in: managers any, reps their own.
  const stateOptions = me && me.role !== 'manager' && me.regions.length ? me.regions : ALL_STATES;

  function startNewStore() {
    setAddingNew(true);
    setSelected(null);
    setConfirmedNotDuplicate(false);
    setStore(s => ({ ...s, name: search.trim() })); // carry over what they typed
  }

  if (addingNew) {
    return (
      <div className="task-new-store">
        <div className="task-acct-head" style={{ marginBottom: 8 }}>
          <div className="acct-name">New store</div>
          <button type="button" className="link-btn" onClick={() => setAddingNew(false)}>Pick an existing account instead</button>
        </div>
        <label className="modal-field">
          Business name
          <input
            value={store.name}
            onChange={e => { setStore({ ...store, name: e.target.value }); setConfirmedNotDuplicate(false); }}
            required
            autoFocus
          />
        </label>
        {possibleDuplicates.length > 0 && (
          <div className="task-dupe">
            <div>This looks like an existing account: {possibleDuplicates.slice(0, 3).join(', ')}</div>
            <label>
              <input type="checkbox" checked={confirmedNotDuplicate} onChange={e => setConfirmedNotDuplicate(e.target.checked)} />
              It's a different store, add it anyway
            </label>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="modal-field" style={{ width: 110 }}>
            State
            <select value={store.region} onChange={e => setStore({ ...store, region: e.target.value })}>
              {stateOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="modal-field" style={{ flex: 1 }}>
            Contact name
            <input value={store.contactName} onChange={e => setStore({ ...store, contactName: e.target.value })} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <label className="modal-field" style={{ flex: 1 }}>
            Phone
            <input type="tel" value={store.phone} onChange={e => setStore({ ...store, phone: e.target.value })} placeholder="e.g. 03 9123 4567" />
          </label>
          <label className="modal-field" style={{ flex: 1 }}>
            Email
            <input type="email" value={store.email} onChange={e => setStore({ ...store, email: e.target.value })} placeholder="name@store.com.au" />
          </label>
        </div>
        {store.email.trim() && !emailValid && (
          <div className="save-msg err" style={{ marginTop: -4, marginBottom: 6 }}>That email address doesn't look right.</div>
        )}
        <div className={'acct-region' + (!hasContact && store.name.trim() ? ' need-contact' : '')}>
          {!hasContact && store.name.trim()
            ? 'Add a phone number or an email so the store can be contacted.'
            : 'Phone or email required (at least one). Saved as a new lead in your name.'}
        </div>
      </div>
    );
  }

  return (
    <label className="modal-field">
      Account
      {selected ? (
        <div className="task-acct">
          <div className="task-acct-head">
            <div>
              <div className="acct-name">{selected.name}</div>
              <div className="acct-region">{selected.region}{selected.repName ? `, rep: ${selected.repName}` : ''}</div>
            </div>
            <button type="button" className="link-btn" onClick={() => { setSelected(null); setSearch(''); }}>Change</button>
          </div>
          <div className="task-acct-facts">
            <div><span className="k">Stage</span>{STAGE_LABELS[selected.stage]}</div>
            <div><span className="k">Contact</span>{selected.contactName ?? '—'}</div>
            <div><span className="k">Phone</span>{selected.phone ?? '—'}</div>
            <div><span className="k">Email</span>{selected.email ?? '—'}</div>
            <div><span className="k">Last order</span>{selected.lastOrderAt ? fmtDateWithYear(selected.lastOrderAt) : 'Never'}</div>
            <div><span className="k">Spend, 12 months</span>{fmtMoney(selected.spend365)}</div>
          </div>
        </div>
      ) : (
        <>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={accounts ? 'Start typing a business name…' : 'Loading accounts…'}
            autoFocus={autoFocus}
          />
          {matches.length > 0 && (
            <div className="task-matches">
              {matches.map(a => (
                // onMouseDown, not onClick: picks reliably even as the
                // input loses focus (matters on phones).
                <div key={a.id} onMouseDown={e => { e.preventDefault(); setSelected(a); setSearch(''); }} className="task-match">
                  {a.name}<span>{a.region}{a.contactName ? `, ${a.contactName}` : ''}</span>
                </div>
              ))}
            </div>
          )}
          <button type="button" className="link-btn" style={{ marginTop: 6 }} onClick={startNewStore}>
            {search.trim().length >= 2
              ? `${matches.length ? 'Not in the list? ' : 'No match. '}Add "${search.trim()}" as a new store`
              : 'New store not in the system? Add it'}
          </button>
        </>
      )}
    </label>
  );
}