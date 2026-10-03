import { useEffect, useState, useMemo, FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { apiGet, apiPost, apiPatch, apiDownload } from '../lib/api';
import { orderStatusPills, stageTag, paymentTag } from '../lib/orderStatus';
import { AccountDetail as AccountDetailType, STAGE_LABELS, fmtMoney, fmtDate, fmtDateWithYear, daysBetween, flagFor, isHistoryOrder } from '../lib/types';

export default function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const [account, setAccount] = useState<AccountDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // One-off email from this account: the draft plus starting templates.
  const [brandFilter, setBrandFilter] = useState('');
  const [productYear, setProductYear] = useState('all');
  const [exportingProducts, setExportingProducts] = useState(false);
  const [exportingOrders, setExportingOrders] = useState(false);
  const [exportingStocklist, setExportingStocklist] = useState(false);
  const [showDue, setShowDue] = useState(false);
  const [type, setType] = useState<'call' | 'email' | 'visit'>('call');
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
  const [editType, setEditType] = useState<'call' | 'email' | 'visit'>('call');
  const [editSaving, setEditSaving] = useState(false);

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
      await apiPost('/activity', { accountId: id, type, note });
      setNote('');
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEditSave(activityId: string) {
    if (!editNote.trim()) return;
    setEditSaving(true);
    try {
      await apiPatch(`/activity/${activityId}`, { note: editNote, type: editType });
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
  const openQuote = liveQuotes.find(q => !q.paid) ?? liveQuotes[0];
  const hasBackorder = liveQuotes.some(q => (q.fulfillmentStatus ?? '').toUpperCase() === 'BACKORDERED');

  // Amount due: live orders that have been invoiced and aren't fully paid.
  // Part payments are taken off. Marketing/warranty orders owe nothing.
  const dueOrders = liveQuotes
    .filter(q => !q.paid && !q.miscType && (q.invoiceDate || q.invoiceNumber)
      && !['VOIDED', 'CREDITED'].includes((q.fulfillmentStatus ?? '').toUpperCase()))
    .map(q => ({ q, due: Math.max(0, (q.total ?? q.amount) - (q.amountPaid ?? 0)) }))
    .filter(d => d.due > 0.005)
    .sort((a, b) => new Date(a.q.invoiceDate ?? a.q.sentAt).getTime() - new Date(b.q.invoiceDate ?? b.q.sentAt).getTime());
  const totalDue = dueOrders.reduce((s, d) => s + d.due, 0);

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
                    ? `Unpaid, ${daysBetween(openQuote!.invoiceDate ?? openQuote!.sentAt)} days`
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
            <h3 className="due-head" onClick={() => dueOrders.length && setShowDue(!showDue)} style={{ cursor: dueOrders.length ? 'pointer' : 'default' }}>
              <span>Amount due</span>
              <span className={'num due-total' + (totalDue > 0 ? ' owing' : '')}>
                {fmtMoney(totalDue)}
                {dueOrders.length > 0 && <span className="due-caret">{showDue ? '▾' : '▸'}</span>}
              </span>
            </h3>
            <div className="acct-region">
              {dueOrders.length
                ? `${dueOrders.length} unpaid ${dueOrders.length === 1 ? 'invoice' : 'invoices'}${showDue ? '' : ', click to see which'}`
                : 'Nothing owing.'}
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
                          Invoiced {fmtDateWithYear(q.invoiceDate ?? q.sentAt)}, {days} {days === 1 ? 'day' : 'days'} ago
                          {q.amountPaid ? `, ${fmtMoney(q.amountPaid)} paid of ${fmtMoney(q.total ?? q.amount)}` : ''}
                        </div>
                      </div>
                      <div className={'num' + (days > 30 ? ' overdue' : '')}>{fmtMoney(due)}</div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <h3>Log a call, email, or visit</h3>
            <form onSubmit={handleLog}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {(['call', 'email', 'visit'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    className={'btn secondary' + (type === t ? ' active' : '')}
                    style={{ textTransform: 'capitalize', opacity: type === t ? 1 : 0.6 }}
                    onClick={() => setType(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="What happened?"
                rows={3}
                style={{ width: '100%', marginBottom: 8 }}
              />
              <button className="btn" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Log activity'}
              </button>
            </form>
          </div>

          <div className="card">
            <h3>Activity</h3>
            {account.activity.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>No activity logged yet.</div>}
            {account.activity.map(t => (
              <div className="timeline-item" key={t.id}>
                <div className="ti-icon">{t.type === 'visit' ? '◎' : t.type === 'call' ? '☎' : '✉'}</div>
                <div className="ti-body">
                  {editingActivityId === t.id ? (
                    <div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                        {(['call', 'email', 'visit'] as const).map(ty => (
                          <button
                            key={ty}
                            type="button"
                            className={'btn secondary' + (editType === ty ? ' active' : '')}
                            style={{ textTransform: 'capitalize', opacity: editType === ty ? 1 : 0.6, padding: '4px 10px', fontSize: 12 }}
                            onClick={() => setEditType(ty)}
                          >
                            {ty}
                          </button>
                        ))}
                      </div>
                      <textarea
                        value={editNote}
                        onChange={e => setEditNote(e.target.value)}
                        rows={2}
                        style={{ width: '100%', marginBottom: 6 }}
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
                        <span style={{ fontWeight: 500, textTransform: 'capitalize' }}>{t.type}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className="num" style={{ color: 'var(--muted)' }}>{fmtDate(t.occurredAt)}</span>
                          <button
                            className="edit-link"
                            onClick={() => { setEditingActivityId(t.id); setEditNote(t.note); setEditType(t.type); }}
                          >
                            Edit
                          </button>
                        </span>
                      </div>
                      {t.repName && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Logged by {t.repName}</div>}
                      <div className="ti-note">{t.note}</div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          {(account.contactName || account.phone || account.email || account.address) && (
            <div className="card">
              <h3>Contact</h3>
              {account.contactName && <div className="kv"><span className="k">Name</span><span>{account.contactName}</span></div>}
              {account.phone && <div className="kv"><span className="k">Phone</span><span><a href={`tel:${account.phone}`} className="order-link">{account.phone}</a></span></div>}
              {account.email && <div className="kv"><span className="k">Email</span><span><a href={`mailto:${account.email}`} className="order-link">{account.email}</a></span></div>}
              {account.address && <div className="kv"><span className="k">Address</span><span>{account.address}</span></div>}
            </div>
          )}

          <div className="card">
            <h3>Account</h3>
            <div className="kv"><span className="k">Type</span><span>{account.type}</span></div>
            <div className="kv"><span className="k">Region</span><span>{account.region}</span></div>
            {account.repName && <div className="kv"><span className="k">Assigned rep</span><span>{account.repName}</span></div>}
            {account.avgOrderGapDays && (
              <div className="kv"><span className="k">Typical reorder gap</span><span className="num">~{account.avgOrderGapDays} days</span></div>
            )}
            <div className="kv"><span className="k">Credit terms</span><span>{account.credit === 'prepay' ? 'Pay first' : 'Credit account'}</span></div>
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
                <span className="acct-region">Monthly stocklist: their current range, plus new products from the brands they stock, with prices and availability.</span>
                <button
                  className="btn secondary"
                  style={{ padding: '4px 10px', fontSize: 11.5, whiteSpace: 'nowrap' }}
                  disabled={exportingStocklist}
                  onClick={() => download(`/exports/account-stocklist?accountId=${account.id}`, `${safeName}-stocklist.xlsx`, setExportingStocklist)}
                >
                  {exportingStocklist ? 'Building…' : '⬇ Stocklist'}
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
    </>
  );
}