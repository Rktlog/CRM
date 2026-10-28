import { useEffect, useState, useMemo, FormEvent } from 'react';
import { useMe, ALL_STATES } from '../lib/useMe';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ACTIVITY_ICON, ACTIVITY_KINDS, ACTIVITY_LABEL, ActivityKind } from '../lib/activityLabels';
import OrderNoteChip from '../components/OrderNoteChip';
import { apiGet, apiPost, apiPatch, apiDelete, apiDownload } from '../lib/api';
import { orderStatusPills, stageTag, paymentTag } from '../lib/orderStatus';
import PriceListModal from '../components/PriceListModal';
import CreditReservations from '../components/CreditReservations';
import AccountEmails from '../components/marketing/AccountEmails';
import { AccountDetail as AccountDetailType, STAGE_LABELS, fmtMoney, fmtDate, fmtDateWithYear, daysBetween, flagFor, isHistoryOrder, isOwingOrder, amountOwing, fmtDuration } from '../lib/types';
import { pickCurrentOrder } from '../lib/currentOrder';
import { todayLocal, dateInputValue, isoForDay } from '../lib/logDate';
import AccountGmail from '../components/AccountGmail';
import DraftEmailButton from '../components/DraftEmailButton';
import DictationTextarea from '../components/DictationTextarea';
import DeleteLogLink from '../components/DeleteLogLink';
import type { Account } from '../lib/types';

// The council worked out from the postcode in the address (the API sends it with the account).
const councilOf = (a: unknown): string | null => (a as { council?: string | null }).council ?? null;
// Names of accounts that were merged into this one (the API sends them with the account).
const formerNamesOf = (a: unknown): string[] => (a as { formerNames?: string[] }).formerNames ?? [];

export default function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  // The rep who logged it, or a manager, can edit or delete a log (the API checks this too).
  const canEditLog = (repId: string) => !!me && (me.role === 'manager' || me.id === repId);
  const [account, setAccount] = useState<AccountDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // One-off email from this account: the draft plus starting templates.
  const [brandFilter, setBrandFilter] = useState('');
  const [productYear, setProductYear] = useState('all');
  const [exportingProducts, setExportingProducts] = useState(false);
  const [exportingOrders, setExportingOrders] = useState(false);
  const [showPriceList, setShowPriceList] = useState(false);
  const [showDue, setShowDue] = useState(false);
  const [type, setType] = useState<ActivityKind>('call');
  const [orderId, setOrderId] = useState('');   // optional: the order this log is about
  const [saving, setSaving] = useState(false);
  const [editingActivityId, setEditingActivityId] = useState<string | null>(null);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);

  // Year-filtered product breakdown, computed client-side from the
  // real per-quote line items already in the response — no extra
  // request needed when switching years.
  const availableProductYears = useMemo(() => {
    if (!account) return [];
    return [...new Set(account.quotes.map(q => new Date(q.sentAt).getFullYear()))].sort((a, b) => b - a);
  }, [account]);

  const filteredProductBreakdown = useMemo(() => {
    if (!account) return [];
    const relevantQuotes = productYear === 'all'
      ? account.quotes
      : account.quotes.filter(q => new Date(q.sentAt).getFullYear() === Number(productYear));

    const bySku = new Map<string, { productName: string; brand: string | null; quantity: number; total: number }>();
    for (const q of relevantQuotes) {
      for (const l of q.lines ?? []) {
        const e = bySku.get(l.sku) ?? { productName: l.productName, brand: l.brand, quantity: 0, total: 0 };
        e.quantity += l.quantity; e.total += l.lineTotal;
        bySku.set(l.sku, e);
      }
    }
    return [...bySku.entries()]
      .map(([sku, v]) => ({ sku, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [account, productYear]);
  const [editNote, setEditNote] = useState('');
  const [editType, setEditType] = useState<ActivityKind>('call');
  const [editSaving, setEditSaving] = useState(false);
  const [logDay, setLogDay] = useState(todayLocal());   // the date of a new log: today unless changed
  const [editDay, setEditDay] = useState('');

  function load() {
    if (!id) return;
    apiGet(`/accounts/${id}`).then(setAccount).catch(e => setError(e.message));
  }

  useEffect(load, [id]);

  async function handleLog(e: FormEvent) {
    e.preventDefault();
    if (!note.trim() || !id) return;
    setSaving(true);
    try {
      await apiPost('/activity', { accountId: id, type, note, ...(orderId ? { orderId } : {}), ...(logDay && logDay !== todayLocal() ? { occurredAt: isoForDay(logDay) } : {}) });
      setNote('');
      setOrderId('');
      setLogDay(todayLocal());
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(activityId: string) {
    if (!editNote.trim() || editDay > todayLocal()) return;
    setEditSaving(true);
    try {
      const orig = account?.activity.find(a => a.id === activityId);
      await apiPatch(`/activity/${activityId}`, {
        note: editNote, type: editType,
        ...(orig && editDay && editDay !== dateInputValue(orig.occurredAt) ? { occurredAt: isoForDay(editDay) } : {}),
      });
      setEditingActivityId(null);
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setEditSaving(false);
    }
  }

  if (error) return <div className="empty-state">Couldn't load account: {error}</div>;
  if (!account) return <div className="empty-state">Loading…</div>;

  const flag = flagFor(account, account.quotes);
  // Payment and backorder status come from live DEAR orders only;
  // spreadsheet history keeps its frozen statuses out of this.
  const liveQuotes = account.quotes.filter(q => !isHistoryOrder(q));
  // The current order: the newest one still in play (not voided or credited), paid or not.
  const openQuote = pickCurrentOrder(liveQuotes);
  const hasBackorder = liveQuotes.some(q => (q.fulfillmentStatus ?? '').toUpperCase() === 'BACKORDERED');

  // Amount due: live orders that have been invoiced and aren't fully paid.
  // Part payments are taken off. Marketing/warranty orders owe nothing.
  // DEAR's balance per order once synced (invoiced - paid - credited), so
  // credit notes and part payments come off and it matches DEAR.
  const dueOrders = liveQuotes
    .filter(q => isOwingOrder(q) && (q.amountDue != null || q.invoiceDate || q.invoiceNumber))
    .map(q => ({ q, due: amountOwing(q) }))
    .filter(d => d.due > 0.005)
    .sort((a, b) => new Date(a.q.invoiceDate ?? a.q.sentAt).getTime() - new Date(b.q.invoiceDate ?? b.q.sentAt).getTime());
  const totalDue = dueOrders.reduce((s, d) => s + d.due, 0);

  // Credit on account (credit notes not yet applied or refunded, and
  // prepayments not yet applied), from any live order, paid or not.
  // Balance = owed - credit, as DEAR shows it: negative means in credit.
  const creditOrders = liveQuotes
    .filter(q => (q.unappliedCredit ?? 0) > 0.005 || (q.amountDue ?? 0) < -0.005)
    .map(q => {
      const notes = ((q.creditNotes ?? []) as { number: string | null; onAccount?: number }[])
        .filter(n => (n.onAccount ?? 0) > 0.005);
      const fromNotes = notes.reduce((s, n) => s + (n.onAccount ?? 0), 0);
      const unapplied = q.unappliedCredit ?? 0;
      // Overpaid: DEAR's balance on the order is below zero.
      const overpaid = (q.amountDue ?? 0) < -0.005 ? -q.amountDue! : 0;
      return { q, credit: unapplied + overpaid, notes, fromNotes, prepayment: Math.max(0, unapplied - fromNotes), overpaid };
    });
  const totalCredit = creditOrders.reduce((s, c) => s + c.credit, 0);
  // What that credit is made of: credit notes, prepayments not yet applied, overpaid orders.
  const totalNotes = creditOrders.reduce((s, c) => s + c.fromNotes, 0);
  const totalPrepaid = creditOrders.reduce((s, c) => s + c.prepayment, 0);
  const totalOverpaid = creditOrders.reduce((s, c) => s + c.overpaid, 0);
  const balance = totalDue - totalCredit;
  const hasMoneyDetail = dueOrders.length > 0 || creditOrders.length > 0;

  async function download(path: string, file: string, setBusy: (b: boolean) => void) {
    setBusy(true);
    try {
      await apiDownload(path, file);
    } finally {
      setBusy(false);
    }
  }
  const safeName = account.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  return (
    <>
      <Link className="back-link" to="/accounts">&larr; All accounts</Link>
      <h2 style={{ margin: '0 0 2px 0' }}>{account.name}</h2>
      {formerNamesOf(account).length > 0 && <div className="acct-region" style={{ marginBottom: 2 }}>Also known as {formerNamesOf(account).join(', ')}</div>}
      <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 18 }}>
        {account.region} · {account.credit === 'prepay' ? 'Pays before dispatch' : 'On credit account'}
      </div>

      <div className="detail-grid">
        <div>
          <div className="card">
            <h3>
              Current order / quote
              {hasBackorder && <span style={{ float: 'right' }}><span className="pill rust">Has a backorder</span></span>}
            </h3>
            <div className="status-line">
              <span>Quote</span>
              <span className="num">
                {openQuote ? `${openQuote.number} · ${fmtMoney(openQuote.amount)} · sent ${fmtDate(openQuote.sentAt)}` : 'None yet'}
              </span>
            </div>
            {openQuote?.invoiceDate && (
              <div className="status-line">
                <span>Invoiced</span>
                <span className="num">{openQuote.number} · {fmtDate(openQuote.invoiceDate)}</span>
              </div>
            )}
            <div className="status-line">
              <span>Payment</span>
              <span className="num">
                {(() => {
                  const pay = openQuote ? paymentTag(openQuote) : null;
                  if (!pay) return '—';
                  // Days unpaid counts from the invoice: before that, nothing is owed yet.
                  return pay.label === 'Unpaid'
                    ? `Unpaid, ${fmtDuration(daysBetween(openQuote!.invoiceDate ?? openQuote!.sentAt))}`
                    : pay.label;
                })()}
              </span>
            </div>
            <div className="status-line">
              <span>Status</span>
              <span>{(() => {
                const stage = openQuote ? stageTag(openQuote) : null;
                return stage ? <span className={`pill ${stage.tone}`}>{stage.label}</span> : <span className="num">—</span>;
              })()}</span>
            </div>
            <div className="status-line">
              <span>Stage</span>
              <span className="num">{STAGE_LABELS[account.stage]}</span>
            </div>
          </div>

          <div className="card">
            <h3 className="due-head" onClick={() => hasMoneyDetail && setShowDue(!showDue)} style={{ cursor: hasMoneyDetail ? 'pointer' : 'default' }}>
              <span>{balance < -0.005 ? 'In credit' : 'Balance'}</span>
              <span className={'num due-total' + (balance > 0.005 ? ' owing' : balance < -0.005 ? ' credit' : '')}>
                {fmtMoney(Math.abs(balance))}
                {hasMoneyDetail && <span className="due-caret">{showDue ? '▾' : '▸'}</span>}
              </span>
            </h3>
            <div className="acct-region">
              {[
                dueOrders.length ? `${fmtMoney(totalDue)} owing on ${dueOrders.length} ${dueOrders.length === 1 ? 'invoice' : 'invoices'}` : '',
                totalNotes > 0.005 ? `${fmtMoney(totalNotes)} on credit notes` : '',
                totalPrepaid > 0.005 ? `${fmtMoney(totalPrepaid)} prepaid and not yet applied` : '',
                totalOverpaid > 0.005 ? `${fmtMoney(totalOverpaid)} overpaid` : '',
              ].filter(Boolean).join(', ') || 'Nothing owing.'}
              {hasMoneyDetail && !showDue ? '. Click for details.' : ''}
            </div>
            {showDue && dueOrders.length > 0 && (
              <div className="due-list">
                {dueOrders.map(({ q, due }) => {
                  const days = daysBetween(q.invoiceDate ?? q.sentAt);
                  return (
                    <Link to={`/orders/${q.id}`} className="due-row" key={q.id}>
                      <div>
                        <div className="acct-name">{q.number}{q.invoiceNumber ? `, inv ${q.invoiceNumber}` : ''}</div>
                        <div className="acct-region">
                          Invoiced {fmtDateWithYear(q.invoiceDate ?? q.sentAt)}, {fmtDuration(days)} ago
                        </div>
                        <div className="due-breakdown">
                          Total {fmtMoney(q.invoicedTotal ?? q.total ?? q.amount)}
                          {(q.amountPaid ?? 0) > 0.005 && <>, paid {fmtMoney(q.amountPaid!)}</>}
                          {(q.creditedTotal ?? 0) > 0.005 && <>, credited {fmtMoney(q.creditedTotal!)}</>}
                        </div>
                        <OrderNoteChip noteCount={q.noteCount} lastNote={q.lastNote} />
                      </div>
                      <div className="due-amount">
                        <div className={'num' + (days > 30 ? ' overdue' : '')}>{fmtMoney(due)}</div>
                        <div className="acct-region">due</div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
            {showDue && creditOrders.length > 0 && (
              <div className="due-list">
                <div className="doc-title" style={{ marginTop: 10 }}>Credit on account</div>
                {creditOrders.map(({ q, credit, notes, prepayment, overpaid }) => (
                  <Link to={`/orders/${q.id}`} className="due-row" key={q.id}>
                    <div>
                      <div className="acct-name">{q.number}</div>
                      <div className="due-breakdown">
                        {[
                          ...notes.map(n => `credit note ${n.number ?? ''} not yet used`),
                          prepayment > 0.005 ? `prepayment of ${fmtMoney(prepayment)} not yet applied` : '',
                          overpaid > 0.005 ? `overpaid by ${fmtMoney(overpaid)}` : '',
                        ].filter(Boolean).join(', ')}
                      </div>
                    </div>
                    <div className="due-amount">
                      <div className="num credit-amount">−{fmtMoney(credit)}</div>
                      <div className="acct-region">credit</div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Credit and reservations: what the team has set aside, on both accounts */}
          <CreditReservations accountId={account.id} accountName={account.name} />
          <AccountEmails accountId={account.id} />
              <DraftEmailButton accountId={account.id} accountName={account.name} defaultTo={account.email} />
              <AccountGmail accountId={account.id} />
 
          <div className="card">
            <h3>Log a phone call, email, F2F visit or remark</h3>
            <form onSubmit={handleLog}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {ACTIVITY_KINDS.map(t => (
                  <button
                    key={t}
                    type="button"
                    className={'btn secondary' + (type === t ? ' active' : '')}
                    style={{ opacity: type === t ? 1 : 0.6 }}
                    onClick={() => setType(t)}
                  >
                    {ACTIVITY_LABEL[t]}
                  </button>
                ))}
              </div>
               {account.quotes.length > 0 && (
                <select value={orderId} onChange={e => setOrderId(e.target.value)} aria-label="Which order is this about" style={{ width: '100%', marginBottom: 8 }}>
                  <option value="">About the account (no particular order)</option>
                  {account.quotes.slice(0, 15).map(q => <option key={q.id} value={q.id}>About order {q.number}, {fmtDateWithYear(q.sentAt)}</option>)}
                </select>
              )}
              <DictationTextarea
                value={note}
                onChange={setNote}
                placeholder={type === 'remark' ? 'Your remark, comment or feedback' : 'What happened?'}
                rows={3}
                style={{ marginBottom: 8 }}
              />
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn" type="submit" disabled={saving || logDay > todayLocal()}>
                  {saving ? 'Saving…' : type === 'remark' ? 'Log remark' : 'Log activity'}
                </button>
                <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  Date
                  <input type="date" value={logDay} max={todayLocal()} onChange={e => setLogDay(e.target.value || todayLocal())} />
                </label>
              </div>
            </form>
          </div>

          <div className="card">
            <h3>Activity</h3>
            {account.activity.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No activity logged yet.</div>}
            {account.activity.map(t => (
              <div className="timeline-item" key={t.id}>
                <div className="ti-icon">{ACTIVITY_ICON[t.type] ?? '✉'}</div>
                <div className="ti-body">
                  {editingActivityId === t.id ? (
                    <div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                        {ACTIVITY_KINDS.map(ty => (
                          <button
                            key={ty}
                            type="button"
                            className={'btn secondary' + (editType === ty ? ' active' : '')}
                            style={{ opacity: editType === ty ? 1 : 0.6, padding: '4px 10px', fontSize: 12 }}
                            onClick={() => setEditType(ty)}
                          >
                            {ACTIVITY_LABEL[ty]}
                          </button>
                        ))}
                      </div>
                      <label className="acct-region" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                        Date
                        <input type="date" value={editDay} max={todayLocal()} onChange={e => setEditDay(e.target.value)} />
                      </label>
                      <DictationTextarea
                        value={editNote}
                        onChange={setEditNote}
                        rows={2}
                        style={{ marginBottom: 6 }}
                      />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setEditingActivityId(null)}>
                          Cancel
                        </button>
                        <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} disabled={editSaving} onClick={() => handleEditSave(t.id)}>
                          {editSaving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="ti-top">
                        <span style={{ fontWeight: 500 }}>{ACTIVITY_LABEL[t.type]}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="num" style={{ color: 'var(--muted)' }}>{fmtDate(t.occurredAt)}</span>
                          {canEditLog(t.repId) && (
                            <>
                              <button
                                className="edit-link"
                                onClick={() => { setEditingActivityId(t.id); setEditNote(t.note); setEditType(t.type); setEditDay(dateInputValue(t.occurredAt)); }}
                              >
                                Edit
                              </button>
                              <DeleteLogLink id={t.id} onDeleted={load} />
                            </>
                          )}
                        </span>
                      </div>
                      {t.repName && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Logged by {t.repName}</div>}
                      {t.orderNumber && t.orderId && <div style={{ fontSize: 11.5 }}>About order <Link to={`/orders/${t.orderId}`} className="order-link">{t.orderNumber}</Link></div>}
                      <div className="ti-note">{t.note}</div>
                      {t.photoUrl && (
                        <a href={t.photoUrl} target="_blank" rel="noreferrer" className="ti-photo" title="Open the full-size photo">
                          <img src={t.photoUrl} alt="Visit photo" loading="lazy" />
                        </a>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          {(account.contactName || account.phone || account.email || account.address || councilOf(account)) && (
            <div className="card">
              <h3 className="contact-head">
                <span>Contact</span>
                {account.dearCustomerId && <span className="dear-tag" title="Linked to a DEAR customer">DEAR</span>}
              </h3>
              {account.dearCustomerId && (
                <div className="dear-note">
                  Synced from DEAR. These details update automatically, so change them in DEAR.
                </div>
              )}
              {account.contactName && <div className="kv"><span className="k">Name</span><span>{account.contactName}</span></div>}
              {account.phone && <div className="kv"><span className="k">Phone</span><span><a href={`tel:${account.phone}`} className="order-link">{account.phone}</a></span></div>}
              {account.email && <div className="kv"><span className="k">Email</span><span><a href={`mailto:${account.email}`} className="order-link">{account.email}</a></span></div>}
              {account.address && <div className="kv"><span className="k">Address</span><span>{account.address}</span></div>}
              {councilOf(account) && <div className="kv"><span className="k">Council</span><span><Link to={`/council/${encodeURIComponent(councilOf(account)!)}`} className="order-link" title="See the other stores in this council">{councilOf(account)}</Link></span></div>}
            </div>
          )}

          <div className="card">
            <h3>Account</h3>
            <TypeRow account={account} onSaved={updated => setAccount(a => (a ? { ...a, ...updated } : a))} />
            <StateRow account={account} onSaved={updated => setAccount(a => (a ? { ...a, ...updated } : a))} />
            <div className="kv">
              <span className="k">Source</span>
              <span>{account.dearCustomerId ? 'DEAR customer' : 'Added in the CRM'}</span>
            </div>
            <div className="kv"><span className="k">Added</span><span className="num">{fmtDateWithYear(account.createdAt)}</span></div>
            {account.repName && <div className="kv"><span className="k">Assigned rep</span><span>{account.repName}</span></div>}
            {account.type === 'customer' && (
              <ReorderGapRow account={account} onSaved={updated => setAccount(a => (a ? { ...a, ...updated } : a))} />
            )}
            <div className="kv">
              <span className="k">Payment terms</span>
              <span>
                {/* No terms on record means Prepayment. */}
                {account.paymentTerms ?? 'Prepayment'}
                <span className="acct-region">
                  {' '}({(account.paymentTerms ? account.credit === 'prepay' : true) ? 'pay first' : 'credit account'}
                  {account.dearCustomerId ? ', from DEAR' : ''})
                </span>
              </span>
            </div>
            <div className="kv">
              <span className="k">Last order</span>
              <span className="num">{account.lastOrderAt ? fmtDate(account.lastOrderAt) : '—'}</span>
            </div>
            {account.nextFollowUpAt && (
              <div className="kv">
                <span className="k">Follow up</span>
                <span className="num">{fmtDate(account.nextFollowUpAt)}</span>
              </div>
            )}
            <AccountAdmin account={account} onChanged={updated => setAccount(a => (a ? { ...a, ...updated } : a))} onMerged={load} />
          </div>

          <div className="card">
            <h3>Spend</h3>
            <div className="spend-grid">
              <div className="spend-cell"><div className="v num">{fmtMoney(account.spend30)}</div><div className="l">Last 30 days</div></div>
              <div className="spend-cell"><div className="v num">{fmtMoney(account.spend90)}</div><div className="l">Last 90 days</div></div>
              <div className="spend-cell"><div className="v num">{fmtMoney(account.spend365)}</div><div className="l">Last 12 months</div></div>
            </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3>Order history</h3>
              {account.quotes.length > 0 && (
                <button
                  className="btn secondary"
                  style={{ padding: '4px 10px', fontSize: 11.5 }}
                  disabled={exportingOrders}
                  onClick={() => download(`/exports/account-orders?accountId=${account.id}`, `${safeName}-order-history.xlsx`, setExportingOrders)}
                >
                  {exportingOrders ? 'Downloading…' : '⬇ Excel'}
                </button>
              )}
            </div>
            {account.quotes.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>No past orders on record.</div>
            )}
            {account.quotes.length > 0 && (
              <div className="scroll-capped-5 order-history-scroll">
              <div className="manifest" style={{ border: 'none' }}>
                <div className="m-row head" style={{ gridTemplateColumns: '1.1fr 0.9fr 1fr', padding: '8px 0' }}>
                  <div>Order no.</div><div className="num">Price</div><div>Status</div>
                </div>
                {account.quotes
                  .slice()
                  .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
                  .map(q => {
                    const open = openOrderId === q.id;
                    const lines = q.lines ?? [];
                    return (
                      <div key={q.id}>
                        <div
                          className="m-row"
                          style={{ gridTemplateColumns: '1.1fr 0.9fr 1fr', padding: '9px 0', cursor: lines.length ? 'pointer' : 'default' }}
                          onClick={() => lines.length && setOpenOrderId(open ? null : q.id)}
                          aria-expanded={lines.length ? open : undefined}
                        >
                          <div>
                            <div className="acct-name">
                              {lines.length > 0 && <span className="order-caret">{open ? '▾' : '▸'}</span>}
                              {q.number}
                            </div>
                            <div className="acct-region">{fmtDateWithYear(q.sentAt)}</div>
                            {(q.shippingCompany || q.shippingAddress) && (
                              <div className="acct-region" style={{ marginTop: 2 }}>
                                📍 {q.shippingCompany ?? q.shippingAddress}
                              </div>
                            )}
                          </div>
                          <div className="num">{fmtMoney(q.amount)}</div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
                            {orderStatusPills(q)}
                          </div>
                        </div>

                        {open && (
                          <div className="order-lines">
                            {lines.map((l, i) => (
                              <div className="order-line" key={i}>
                                <div>
                                  <div>{l.productName}</div>
                                  <div className="acct-region num">{l.sku}{l.brand ? `, ${l.brand}` : ''}</div>
                                </div>
                                <div className="num">{l.quantity} × {fmtMoney(l.unitPrice)}</div>
                                <div className="num">{fmtMoney(Math.round(l.lineTotal * 100) / 100)}</div>
                              </div>
                            ))}
                            <Link to={`/orders/${q.id}`} className="order-link order-full-link">Full order details</Link>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
              </div>
            )}
          </div>

          {account.productBreakdown.length > 0 && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3>Products purchased</h3>
                <button
                  className="btn secondary"
                  style={{ padding: '4px 10px', fontSize: 11.5 }}
                  disabled={exportingProducts}
                  onClick={async () => {
                    setExportingProducts(true);
                    try {
                      const safeName = account.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
                      await apiDownload(`/exports/account-products?accountId=${account.id}`, `${safeName}-products.xlsx`);
                    } finally {
                      setExportingProducts(false);
                    }
                  }}
                >
                  {exportingProducts ? 'Downloading…' : '⬇ Excel'}
                </button>
              </div>
              <div className="stocklist-row">
                <span className="acct-region">Price list to send them: every product in their brands, with their current range and new arrivals highlighted, prices, increments and availability.</span>
                <button
                  className="btn secondary"
                  style={{ padding: '4px 10px', fontSize: 11.5, whiteSpace: 'nowrap' }}
                  onClick={() => setShowPriceList(true)}
                >
                  ⬇ Price list…
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <select
                  value={productYear}
                  onChange={e => setProductYear(e.target.value)}
                  style={{ padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 3, fontSize: 12.5 }}
                >
                  <option value="all">All time</option>
                  {availableProductYears.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <select
                  value={brandFilter}
                  onChange={e => setBrandFilter(e.target.value)}
                  style={{ padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 3, fontSize: 12.5 }}
                >
                  <option value="">All brands</option>
                  {[...new Set(filteredProductBreakdown.map(p => p.brand).filter(Boolean))].sort().map(b => (
                    <option key={b} value={b!}>{b}</option>
                  ))}
                </select>
              </div>
              <div className="scroll-capped-5">
              <div className="manifest" style={{ border: 'none' }}>
                <div className="m-row head" style={{ gridTemplateColumns: '1.6fr 0.8fr 0.6fr 0.8fr', padding: '8px 0' }}>
                  <div>Product</div><div>Brand</div><div className="num">Qty</div><div className="num">Total</div>
                </div>
                {filteredProductBreakdown.length === 0 ? (
                  <div style={{ padding: '12px 0', color: 'var(--muted)', fontSize: 13 }}>No orders in {productYear === 'all' ? 'this account\'s history' : productYear}.</div>
                ) : filteredProductBreakdown
                  .filter(p => !brandFilter || p.brand === brandFilter)
                  .map(p => (
                    <div className="m-row" key={p.sku} style={{ gridTemplateColumns: '1.6fr 0.8fr 0.6fr 0.8fr', cursor: 'default', padding: '9px 0' }}>
                      <div>
                        <div className="acct-name">{p.productName}</div>
                        <div className="acct-region">{p.sku}</div>
                      </div>
                      <div>{p.brand ?? '—'}</div>
                      <div className="num">{p.quantity.toLocaleString()}</div>
                      <div className="num">{fmtMoney(p.total)}</div>
                    </div>
                  ))}
              </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {showPriceList && (
        <PriceListModal accountId={account.id} accountName={account.name} onClose={() => setShowPriceList(false)} />
      )}
    </>
  );
}
// Usual reorder gap: calculated from their orders (ordering rounds, typical
// gap), or set by hand for accounts where that doesn't fit, such as several
// branches ordering through one account. Drives Due / Overdue everywhere.
function ReorderGapRow({ account, onSaved }: {
  account: { id: string; avgOrderGapDays: number | null; reorderGapAuto?: number | null; reorderGapOverride?: number | null };
  onSaved: (a: any) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(account.reorderGapOverride ?? account.avgOrderGapDays ?? ''));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manual = account.reorderGapOverride != null;

  async function save(days: number | null) {
    setSaving(true); setError(null);
    try {
      const updated = await apiPatch(`/accounts/${account.id}/reorder-gap`, { days });
      onSaved(updated);
      setEditing(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="kv" style={{ alignItems: 'flex-start' }}>
      <span className="k">Usual reorder gap</span>
      {!editing ? (
        <span>
          <span className="num">{account.avgOrderGapDays ? `every ${fmtDuration(account.avgOrderGapDays)}` : 'not enough orders yet'}</span>
          <span className="acct-region"> ({manual ? 'set manually' : 'calculated'})</span>{' '}
          <button className="link-btn" onClick={() => { setValue(String(account.avgOrderGapDays ?? '')); setEditing(true); }}>Change</button>
        </span>
      ) : (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            every <input type="number" min={1} max={365} value={value} onChange={e => setValue(e.target.value)}
              style={{ width: 70, padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6 }} /> days
            <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={saving || !value}
              onClick={() => save(Number(value))}>Save</button>
            <button className="link-btn" onClick={() => setEditing(false)}>Cancel</button>
          </span>
          {manual && (
            <button className="link-btn" style={{ alignSelf: 'flex-start' }} disabled={saving} onClick={() => save(null)}>
              Go back to calculated{account.reorderGapAuto ? ` (every ${fmtDuration(account.reorderGapAuto)})` : ''}
            </button>
          )}
          <span className="acct-region">Useful when several branches order through this account.</span>
          {error && <span className="save-msg err">{error}</span>}
        </span>
      )}
    </div>
  );
}

// Type (Customer or Prospect), with a Change button for managers. A customer is kept up to date from DEAR; a prospect's details stay with the rep.
type AccountKind = 'prospect' | 'lead' | 'customer' | 'cold_lead';
const TYPE_LABEL: Record<AccountKind, string> = { customer: 'Customer', lead: 'Lead', prospect: 'Prospect', cold_lead: 'Cold lead' };
const TYPE_HELP: Record<AccountKind, string> = {
  customer: 'A customer is kept up to date from DEAR (contact details, payment terms and orders) and gets reorder follow-ups in the Planner.',
  lead: "A lead has shown interest. Their details stay with the rep, DEAR does not update them, and the Planner does not suggest them for cold outreach.",
  prospect: "A prospect has not been approached yet. Their details stay with the rep, DEAR does not update them, and the Planner can suggest them for outreach.",
  cold_lead: "A cold lead does not want to be contacted. The Planner never suggests them and no task can be scheduled for them, they are left out of Inactive stockists and marketing emails, and their orders still come in from DEAR.",
};
function TypeRow({ account, onSaved }: { account: { id: string; type: AccountKind; lastOrderAt: string | null }; onSaved: (a: any) => void }) {
  const me = useMe();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<AccountKind>(account.type);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true); setError(null);
    try {
      onSaved(await apiPatch(`/accounts/${account.id}/type`, { type: value }));
      setEditing(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="kv" style={{ alignItems: 'flex-start' }}>
      <span className="k">Type</span>
      {!editing ? (
        <span>
          {TYPE_LABEL[account.type] ?? account.type}
          {me?.role === 'manager' && (
            <>{' '}<button className="link-btn" onClick={() => { setValue(account.type); setError(null); setEditing(true); }}>Change</button></>
          )}
        </span>
      ) : (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <select aria-label="Type" value={value} onChange={e => setValue(e.target.value as AccountKind)}
              style={{ padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6 }}>
              <option value="customer">Customer</option>
              <option value="lead">Lead</option>
              <option value="prospect">Prospect</option>
              <option value="cold_lead">Cold lead</option>
            </select>
            <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={saving || value === account.type} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="link-btn" onClick={() => setEditing(false)}>Cancel</button>
          </span>
          <span className="acct-region" style={{ maxWidth: 340 }}>
            {TYPE_HELP[value]}
            {value !== 'customer' && value !== 'cold_lead' && account.type === 'customer' && account.lastOrderAt ? ` This account has ordered before: as a ${value} it stops being updated from DEAR.` : ''}
            {value === 'cold_lead' && account.type !== 'cold_lead' ? ' Their email addresses are also taken off the marketing lists. Changing the type back puts them back.' : ''}
          </span>
          {error && <span className="save-msg err">{error}</span>}
        </span>
      )}
    </div>
  );
}

// Managers: archive an account, or delete it. An account with orders cannot be deleted (its orders count in the sales figures): the check
// says so and offers to archive it instead. Deleting asks you to type the account's name.
type DeleteCheck = { name: string; linkedToDear: boolean; canDelete: boolean; reason: string | null; orders: number; logs: number; tasks: number; emails: number };
function AccountAdmin({ account, onChanged, onMerged }: { account: { id: string; name: string; archived: boolean }; onChanged: (a: any) => void; onMerged: () => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<DeleteCheck | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<'archive' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  if (me?.role !== 'manager') return null;

  async function archive(archived: boolean) {
    setBusy('archive'); setError(null);
    try { onChanged(await apiPatch(`/accounts/${account.id}/archive`, { archived })); setOpen(false); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(null); }
  }
  async function startDelete() {
    setOpen(true); setCheck(null); setTyped(''); setError(null);
    try { setCheck(await apiGet(`/accounts/${account.id}/delete-check`, { fresh: true })); }
    catch (e: any) { setError(e.message); }
  }
  async function remove() {
    setBusy('delete'); setError(null);
    try { await apiDelete(`/accounts/${account.id}`); navigate('/accounts'); }
    catch (e: any) { setError(e.message); setBusy(null); }
  }
  const confirmed = typed.trim().toLowerCase() === account.name.trim().toLowerCase();
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  return (
    <div className="kv" style={{ alignItems: 'flex-start' }}>
      <span className="k">Manage</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span>
          {account.archived
            ? <button className="link-btn" disabled={!!busy} onClick={() => archive(false)}>{busy === 'archive' ? 'Restoring…' : 'Restore account'}</button>
            : <button className="link-btn" disabled={!!busy} onClick={() => archive(true)}>{busy === 'archive' ? 'Archiving…' : 'Archive account'}</button>}
          {' · '}
          <button className="link-btn" disabled={!!busy} onClick={() => setMergeOpen(o => !o)}>Merge another account into this one…</button>
          {' · '}
          <button className="link-btn" style={{ color: 'var(--rust)' }} disabled={!!busy} onClick={startDelete}>Delete account…</button>
        </span>
        {account.archived && <span className="acct-region">Archived: hidden from the lists and reports. Its orders still count.</span>}
        {open && (
          <span role="alertdialog" aria-label="Delete this account" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6, maxWidth: 380 }}>
            {!check && !error && <span className="acct-region">Checking what deleting would remove…</span>}
            {check && !check.canDelete && (
              <>
                <span>{check.reason}</span>
                <span style={{ display: 'flex', gap: 8 }}>
                  {!account.archived && <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={!!busy} onClick={() => archive(true)}>Archive instead</button>}
                  <button className="link-btn" onClick={() => setOpen(false)}>Close</button>
                </span>
              </>
            )}
            {check && check.canDelete && (
              <>
                <span>
                  This permanently deletes <b>{check.name}</b>
                  {check.logs + check.tasks + check.emails > 0 ? `, with its ${[check.logs ? plural(check.logs, 'logged activity').replace('activitys', 'activities') : '', check.tasks ? plural(check.tasks, 'task') : '', check.emails ? plural(check.emails, 'logged email') : ''].filter(Boolean).join(', ')}` : ''}. This can't be undone.
                </span>
                {check.linkedToDear && <span className="acct-region">It is linked to a DEAR customer. DEAR is not touched, and if that customer is still in DEAR the DEAR sync may add it back.</span>}
                <label className="acct-region" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  Type the account name to confirm
                  <input aria-label="Type the account name to confirm" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off"
                    style={{ padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6 }} />
                </label>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button className="btn" style={{ padding: '4px 10px', fontSize: 12, background: 'var(--rust)' }} disabled={!confirmed || !!busy} onClick={remove}>{busy === 'delete' ? 'Deleting…' : 'Delete account'}</button>
                  <button className="link-btn" disabled={!!busy} onClick={() => setOpen(false)}>Cancel</button>
                </span>
              </>
            )}
          </span>
        )}
        {mergeOpen && <MergeAccount account={account} onMerged={onMerged} onClose={() => setMergeOpen(false)} />}
        {error && <span className="save-msg err">{error}</span>}
      </span>
    </div>
  );
}

// Managers: merge a duplicate account into this one. Find the duplicate, see exactly what will move, then type its name to confirm.
// (Usually a lead taken under one name, whose trading name DEAR later set up as a second account.) Everything on the duplicate moves here, its
// name is kept as a former name so searching either name finds this account, and the duplicate is deleted. This cannot be undone.
type MergeCheckResult = {
  from: { name: string; type: string; region: string; repName: string | null; dearLinked: boolean };
  canMerge: boolean; reason: string | null;
  moves: { logs: number; tasks: number; orders: number; emails: number; other: number };
  becomes: { type: string };
  warnings: string[];
};
const MERGE_TYPE_WORD: Record<string, string> = { customer: 'Customer', lead: 'Lead', prospect: 'Prospect', cold_lead: 'Cold lead' };
function MergeAccount({ account, onMerged, onClose }: { account: { id: string; name: string }; onMerged: () => void; onClose: () => void }) {
  const [accounts, setAccounts] = useState<(Account & { archived?: boolean })[] | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<(Account & { archived?: boolean }) | null>(null);
  const [check, setCheck] = useState<MergeCheckResult | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live accounts and archived ones: a duplicate is often archived before anyone thinks to merge it.
  useEffect(() => {
    Promise.all([apiGet('/accounts'), apiGet('/accounts?archived=true').catch(() => [])])
      .then(([live, archived]) => setAccounts([...(live as Account[]), ...(archived as Account[]).map(a => ({ ...a, archived: true }))]))
      .catch((e: any) => setError(e.message));
  }, []);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!accounts || picked || s.length < 2) return [];
    return accounts
      .filter(a => a.id !== account.id && [a.name, ...(a.formerNames ?? []), a.contactName ?? '', a.email ?? ''].some(v => v.toLowerCase().includes(s)))
      .slice(0, 8);
  }, [accounts, q, picked, account.id]);

  async function choose(a: Account & { archived?: boolean }) {
    setPicked(a); setCheck(null); setTyped(''); setError(null);
    try { setCheck(await apiGet(`/accounts/${account.id}/merge-check?from=${a.id}`, { fresh: true })); }
    catch (e: any) { setError(e.message); }
  }
  function chooseAnother() { setPicked(null); setCheck(null); setTyped(''); setError(null); }
  async function merge() {
    if (!picked) return;
    setBusy(true); setError(null);
    try { await apiPost(`/accounts/${account.id}/merge`, { fromId: picked.id }); onMerged(); onClose(); }
    catch (e: any) { setError(e.message); setBusy(false); }
  }

  const confirmed = !!picked && typed.trim().toLowerCase() === picked.name.trim().toLowerCase();
  const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-AU')} ${count === 1 ? one : many}`;
  const bits = check ? [
    check.moves.logs ? n(check.moves.logs, 'logged activity', 'logged activities') : '', check.moves.tasks ? n(check.moves.tasks, 'task') : '',
    check.moves.orders ? n(check.moves.orders, 'order') : '', check.moves.emails ? n(check.moves.emails, 'logged email') : '', check.moves.other ? n(check.moves.other, 'other record') : '',
  ].filter(Boolean) : [];

  return (
    <span role="dialog" aria-label="Merge another account into this one" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 6, maxWidth: 420 }}>
      <b>Merge a duplicate into {account.name}</b>
      {!picked && (
        <>
          <span className="acct-region">Find the duplicate by its name, contact or email. Its logs, tasks, orders and emails move to this account, and its name is kept so either name finds it.</span>
          <input aria-label="Find the duplicate account" autoFocus placeholder="Start typing a name, contact or email" value={q} onChange={e => setQ(e.target.value)} autoComplete="off"
            style={{ padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6 }} />
          {!accounts && !error && <span className="acct-region">Loading accounts…</span>}
          {q.trim().length >= 2 && accounts && matches.length === 0 && <span className="acct-region">No other account matches.</span>}
          {matches.map(a => (
            <button key={a.id} type="button" className="link-btn" style={{ textAlign: 'left', display: 'block' }} onClick={() => choose(a)}>
              <span className="acct-name">{a.name}</span>
              <span className="acct-region" style={{ display: 'block' }}>{[a.region, a.archived ? 'archived' : a.status, a.repName, a.email].filter(Boolean).join(' · ')}</span>
            </button>
          ))}
        </>
      )}
      {picked && (
        <>
          <span>Merge <b>{picked.name}</b> into <b>{account.name}</b>?</span>
          {!check && !error && <span className="acct-region">Checking what would move…</span>}
          {check && !check.canMerge && <span>{check.reason}</span>}
          {check && check.canMerge && (
            <>
              <span>Moves to this account: <b>{bits.length ? bits.join(', ') : 'nothing else'}</b>.</span>
              <span className="acct-region">&ldquo;{picked.name}&rdquo; is kept as a former name, so searching either name finds this account. The duplicate account is then deleted. <b>This cannot be undone.</b></span>
              {check.warnings.map(w => <span key={w} className="acct-region">• {w}</span>)}
              <label className="acct-region" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                Type the duplicate&rsquo;s name to confirm
                <input aria-label="Type the duplicate account's name to confirm" value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off"
                  style={{ padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6 }} />
              </label>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn" style={{ padding: '4px 10px', fontSize: 12, background: 'var(--rust)' }} disabled={!confirmed || busy} onClick={merge}>{busy ? 'Merging…' : 'Merge accounts'}</button>
                <button className="link-btn" disabled={busy} onClick={chooseAnother}>Choose another</button>
              </span>
            </>
          )}
          {check && !check.canMerge && <button className="link-btn" style={{ textAlign: 'left' }} onClick={chooseAnother}>Choose another account</button>}
        </>
      )}
      {error && <span className="save-msg err">{error}</span>}
      <button className="link-btn" style={{ textAlign: 'left' }} disabled={busy} onClick={onClose}>Close</button>
    </span>
  );
}

// State, with a Change button for managers: e.g. move a head office (NSW/HO,
// VIC/HO) back to a normal state, or a store into a head office.
function StateRow({ account, onSaved }: { account: { id: string; region: string }; onSaved: (a: any) => void }) {
  const me = useMe();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(account.region);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isHO = account.region.endsWith('/HO');

  async function save() {
    setSaving(true); setError(null);
    try {
      onSaved(await apiPatch(`/accounts/${account.id}/region`, { region: value }));
      setEditing(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="kv" style={{ alignItems: 'flex-start' }}>
      <span className="k">State</span>
      {!editing ? (
        <span>
          {account.region}{isHO && <span className="acct-region"> (head office)</span>}
          {me?.role === 'manager' && (
            <>{' '}<button className="link-btn" onClick={() => { setValue(account.region); setEditing(true); }}>Change</button></>
          )}
        </span>
      ) : (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <select value={value} onChange={e => setValue(e.target.value)}
              style={{ padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6 }}>
              {[...ALL_STATES, 'Unknown'].map(s => (
                <option key={s} value={s}>{s.endsWith('/HO') ? `${s} (head office)` : s}</option>
              ))}
            </select>
            <button className="btn secondary" style={{ padding: '4px 10px', fontSize: 12 }} disabled={saving || value === account.region} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button className="link-btn" onClick={() => setEditing(false)}>Cancel</button>
          </span>
          <span className="acct-region">Reps only see accounts in the states assigned to them in Settings.</span>
          {error && <span className="save-msg err">{error}</span>}
        </span>
      )}
    </div>
  );
}