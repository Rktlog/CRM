import { prisma } from './prisma';
import { territoryWhere, canSeeAccount } from './territory';
import { helpers, DataError, visibleIds } from './aiData';
import { paymentState, followUpState, melDay } from './receivables';

// Everything saved about ONE customer or ONE order, in one go, so the assistant can answer "tell me about X" without
// guessing which look-ups to make. It follows the same rules as the account and order screens: whoever can open the
// customer sees all of it. The only things never read are keys and sign-in details.
type Ctx = { rep: { id: string; role: string }; today: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (s: unknown, n = 400) => { const t = s == null ? null : String(s); return t && t.length > n ? `${t.slice(0, n)}…` : t; };
const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : null);
const cents = (n: number) => Math.round(n * 100) / 100;
const MAX_CHARS = 24000;

// Keeps a big answer valid and under the size cap by shortening the longest lists, and says what was shortened.
export function fitObject(obj: Record<string, any>, max = MAX_CHARS): string {
  const cut: Record<string, number> = {};
  const size = () => JSON.stringify(obj).length;
  while (size() > max) {
    let best: string | null = null, len = 1;
    for (const [k, v] of Object.entries(obj)) if (Array.isArray(v) && v.length > len) { best = k; len = v.length; }
    if (!best) break;
    const keep = Math.max(1, Math.floor(obj[best].length / 2));
    cut[best] = (cut[best] ?? obj[best].length) as number; obj[best] = obj[best].slice(0, keep);
    obj.cutToFit = Object.fromEntries(Object.entries(cut).map(([k, total]) => [k, `showing ${obj[k].length} of ${total}`]));
  }
  return JSON.stringify(obj);
}

// A customer by id or by name. One match is used; several come back as choices.
async function resolveAccount(ctx: Ctx, ref: unknown): Promise<{ row: any } | { choices: { id: string; name: string; state: string }[] }> {
  const text = String(ref ?? '').trim();
  if (!text) throw new DataError('Say which customer: a name, or an id from find_accounts');
  let id = UUID.test(text) ? text : null;
  if (!id) {
    const found = await prisma.account.findMany({
      where: { AND: [await territoryWhere(ctx.rep as any), { name: { contains: text, mode: 'insensitive' } }] },
      select: { id: true, name: true, region: true }, orderBy: { spend365: 'desc' }, take: 6,
    });
    if (!found.length) throw new DataError(`No customer you can open matches "${text}"`);
    const exact = found.filter((f: { name: string }) => f.name.toLowerCase() === text.toLowerCase());
    if (found.length > 1 && exact.length !== 1) return { choices: found.map((f: { id: string; name: string; region: string }) => ({ id: f.id, name: f.name, state: f.region })) };
    id = (exact[0] ?? found[0]).id;
  }
  const [row] = await prisma.$queryRaw<any[]>`select * from crm.accounts where id = ${id}::uuid`;
  if (!row || !(await canSeeAccount(ctx.rep as any, { id: row.id, repId: row.rep_id, region: row.region } as any))) throw new DataError('That customer is not available to you');
  return { row };
}

const PROFILE_KEYS = ['name', 'region', 'contact_name', 'phone', 'email', 'address', 'category', 'payment_terms', 'type', 'stage', 'spend_30', 'spend_90', 'spend_365', 'last_order_at', 'created_at', 'archived', 'misc'];
const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// ---------- one customer ----------
export async function accountDetails(ctx: Ctx, ref: unknown): Promise<string> {
  const r = await resolveAccount(ctx, ref);
  if ('choices' in r) return JSON.stringify({ note: 'More than one customer matches. Ask which, or call again with an id.', matches: r.choices });
  const a = r.row, id: string = a.id, isManager = ctx.rep.role === 'manager';
  const hidden = !!(a.archived || a.misc);   // emails are not logged for these any more, and old ones are not shown either
  const [rep] = a.rep_id ? await prisma.$queryRaw<any[]>`select name from crm.reps where id = ${a.rep_id}::uuid` : [null];
  const [status] = await prisma.$queryRaw<any[]>`select status from crm.account_status where account_id = ${id}::uuid`;

  const [orders, notes, emailRows, mkt, tasks, products] = await Promise.all([
    prisma.$queryRaw<any[]>`select q.number, q.sent_at, q.fulfillment_status as status, q.total, q.amount, q.amount_paid, q.unapplied_credit, q.amount_due, q.invoiced_total, q.credit_notes, q.misc_type, q.reference
                            from crm.quotes q where q.account_id = ${id}::uuid and q.source <> 'rhino-history' and q.number not like 'Q%' order by q.sent_at desc limit 15`,
    prisma.$queryRaw<any[]>`select x.type::text as type, x.note, x.occurred_at, r.name as rep, qq.number as order_no
                            from crm.activity x left join crm.reps r on r.id = x.rep_id left join crm.quotes qq on qq.id = x.quote_id
                            where x.account_id = ${id}::uuid order by x.occurred_at desc limit 15`,
    hidden ? Promise.resolve([] as any[]) : prisma.$queryRaw<any[]>`select l.thread_id, l.direction, l.subject, l.snippet, l.occurred_at, r.name as rep
                            from crm.email_log l join crm.reps r on r.id = l.rep_id where l.account_id = ${id}::uuid order by l.occurred_at desc limit 40`,
    prisma.$queryRaw<any[]>`select m.sent_at, m.subject, m.status, m.opened_at, m.click_count as clicks, coalesce(c.name, ma.key) as source
                            from crm.marketing_messages m left join crm.marketing_contacts k on k.id = m.contact_id
                            left join crm.marketing_campaigns c on c.id = m.campaign_id left join crm.marketing_automations ma on ma.key = m.automation_key
                            where m.sent_at is not null and (k.account_id = ${id}::uuid or (${a.email ?? ''} <> '' and lower(m.email) = lower(${a.email ?? ''})))
                            order by m.sent_at desc limit 10`,
    prisma.task.findMany({ where: { accountId: id, completed: false, ...(isManager ? {} : { repId: ctx.rep.id }) }, orderBy: { scheduledDate: 'asc' }, take: 10 }),
    prisma.$queryRaw<any[]>`select l.sku, max(l.product_name) as product, max(l.brand) as brand, sum(l.quantity)::float8 as qty, sum(l.line_total)::float8 as total
                            from crm.quote_lines l join crm.quotes q on q.id = l.quote_id where q.account_id = ${id}::uuid group by l.sku order by total desc limit 10`,
  ]);

  const region = [a.region as string];
  const [open, invoices, held, creditNotes, reservations] = await Promise.all([
    helpers.openQuotes(ctx.rep, region).then((x: any) => x.rows.filter((q: any) => q.accountId === id)),
    helpers.unpaidInvoices(ctx.rep, region).then((x: any) => x.rows.filter((q: any) => q.accountId === id)),
    helpers.loadHeld(ctx.rep, {}, id) as Promise<any[]>,
    helpers.loadCreditNotes(ctx.rep, {}, id) as Promise<any[]>,
    (helpers.loadReservations(ctx.rep, { q: a.name }) as Promise<any[]>).then(x => x.filter(q => q.accountId === id || q.toAccountId === id)),
  ]);

  // The emails, grouped into conversations like the account screen does.
  const threads = new Map<string, any>();
  for (const m of emailRows) {
    const t = threads.get(m.thread_id) ?? { subject: '', lastDate: day(m.occurred_at), lastDirection: /^in/i.test(m.direction) ? 'Received' : 'Sent', emails: 0, latestPreview: clip(m.snippet, 300), latestBy: m.rep };
    t.emails++; t.subject = String(m.subject ?? '').replace(/^\s*((re|fwd?)\s*:\s*)+/i, '').trim() || t.subject;
    threads.set(m.thread_id, t);
  }

  const profile: Record<string, unknown> = {};
  for (const k of PROFILE_KEYS) if (a[k] !== undefined && a[k] !== null && a[k] !== '') profile[camel(k)] = k.endsWith('_at') ? day(a[k]) : a[k];
  const owing = cents(invoices.reduce((s: number, i: any) => s + i.due, 0));
  return fitObject({
    customer: { ...profile, rep: rep?.name ?? null, status: status?.status ?? null },
    balance: { owing, overdue: cents(invoices.filter((i: any) => i.daysOverdue > 0).reduce((s: number, i: any) => s + i.due, 0)), unpaidInvoices: invoices.length },
    unpaidInvoices: invoices.map((i: any) => ({ order: i.number, invoice: i.invoice, dueDate: day(i.dueDate), daysOverdue: i.daysOverdue, due: i.due })),
    openQuotesAndUnpaidOrders: open.map((q: any) => ({ order: q.number, date: day(q.date), stage: q.stage, total: q.amount, paid: q.paid, stillToPay: q.remaining, payment: q.payment, nextFollowUp: q.followUp.next ? `${q.followUp.next.kind} ${q.followUp.next.date}` : 'done', lastNote: clip(q.lastNote, 200) })),
    recentOrders: orders.map(q => { const p = paymentState({ total: q.total, amount: q.amount, amountPaid: q.amount_paid, unappliedCredit: q.unapplied_credit, amountDue: q.amount_due, invoicedTotal: q.invoiced_total, creditNotes: q.credit_notes }); return { order: q.number, date: day(q.sent_at), status: q.status, totalIncGst: p.total, paid: p.paid, stillToPay: p.remaining, ...(q.misc_type ? { type: q.misc_type } : {}), reference: clip(q.reference, 80) }; }),
    credit: {
      heldOnOrders: held.map(h => ({ order: h.number, kind: h.kind, amount: h.amount, freeToReserve: h.free, status: h.status })),
      creditNotes: creditNotes.map(c => ({ creditNote: c.creditNo, order: c.orderNo, onAccount: c.onAccount, free: c.free })),
      reservations: reservations.map(x => ({ amount: x.amount, from: x.account, to: x.forAccount, forOrder: x.orderRef, status: x.status })),
    },
    teamNotes: notes.map(n => ({ date: day(n.occurred_at), type: n.type, by: n.rep, order: n.order_no, note: clip(n.note) })),
    emails: [...threads.values()].slice(0, 12),
    ...(hidden ? { emailsNote: 'Emails are not shown for hidden (archived) customers.' } : {}),
    marketingEmails: mkt.map(m => ({ sentOn: day(m.sent_at), subject: clip(m.subject, 150), status: m.status, opened: m.opened_at ? 'Yes' : 'No', clicks: Number(m.clicks) || 0, source: m.source })),
    plannerTasks: tasks.map((t: any) => ({ date: day(t.scheduledDate), type: String(t.type), reason: clip(t.reason, 150), note: clip(t.note, 200) })),
    topProductsBought: products.map(p => ({ sku: p.sku, product: p.product, brand: p.brand, qty: p.qty, total: cents(p.total) })),
  });
}

// ---------- one order ----------
export async function orderDetails(ctx: Ctx, ref: unknown): Promise<string> {
  const no = String(ref ?? '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}-?\d{3,}$/.test(no)) throw new DataError('Give an order number, like SQ37604');
  const [q] = await prisma.$queryRaw<any[]>`
    select q.*, a.name as account_name, a.region as account_region, a.rep_id as account_rep_id, a.archived as account_archived, a.misc as account_misc, a.contact_name as account_contact, a.phone as account_phone, a.email as account_email
    from crm.quotes q join crm.accounts a on a.id = q.account_id where upper(q.number) = ${no} order by q.sent_at desc limit 1`;
  if (!q) throw new DataError(`${no} isn't in the CRM`);
  if (!(await canSeeAccount(ctx.rep as any, { id: q.account_id, repId: q.account_rep_id, region: q.account_region } as any))) throw new DataError('That order is outside your states');
  const id: string = q.id, accountId: string = q.account_id;

  const [lines, notes, emails] = await Promise.all([
    prisma.$queryRaw<any[]>`select l.sku, l.product_name as product, l.brand, l.quantity::float8 as qty, l.unit_price::float8 as unit_price, l.discount::float8 as discount, l.line_total::float8 as line_total
                            from crm.quote_lines l where l.quote_id = ${id}::uuid order by l.sku limit 300`,
    prisma.$queryRaw<any[]>`select x.type::text as type, x.note, x.occurred_at, r.name as rep from crm.activity x left join crm.reps r on r.id = x.rep_id
                            where x.quote_id = ${id}::uuid order by x.occurred_at desc, x.created_at desc limit 50`,
    (q.account_archived || q.account_misc) ? Promise.resolve([] as any[]) : prisma.$queryRaw<any[]>`select l.direction, l.subject, l.snippet, l.occurred_at, r.name as rep from crm.email_log l join crm.reps r on r.id = l.rep_id
                            where l.account_id = ${accountId}::uuid and (l.subject ilike ${'%' + no + '%'} or l.snippet ilike ${'%' + no + '%'}) order by l.occurred_at desc limit 10`,
  ]);
  const pay = paymentState({ total: q.total, amount: q.amount, amountPaid: q.amount_paid, unappliedCredit: q.unapplied_credit, amountDue: q.amount_due, invoicedTotal: q.invoiced_total, creditNotes: q.credit_notes });
  const status = String(q.fulfillment_status ?? '').toUpperCase();
  const quoteStage = ['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING'].includes(status);
  const held = ((await helpers.loadHeld(ctx.rep, {}, accountId)) as any[]).filter(h => String(h.number).toUpperCase() === no);
  const reservations = ((await helpers.loadReservations(ctx.rep, { q: q.account_name })) as any[]).filter(x => x.orderRef === no || x.sourceOrder === no || String(x.orderRef ?? '').toUpperCase() === no);
  const docs = Array.isArray(q.invoices) ? q.invoices : [], cn = Array.isArray(q.credit_notes) ? q.credit_notes : [];
  const simple = (o: any) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v)));
  const fu = followUpState(melDay(q.sent_at), { manualOn: day(q.follow_up_at), fu1DoneOn: day(q.fu1_done_on), fu2DoneOn: day(q.fu2_done_on) });

  return fitObject({
    order: { number: q.number, customer: q.account_name, state: q.account_region, contact: q.account_contact, phone: q.account_phone, email: q.account_email, reference: q.reference, date: day(q.sent_at), status: q.fulfillment_status, shipping: q.shipping_status, picking: q.picking_status, kind: q.misc_type ?? (quoteStage ? 'Quote or draft order' : 'Sale'), invoiceNumber: q.invoice_number, invoiceDate: day(q.invoice_date) },
    money: { totalIncGst: pay.total, paidSoFar: pay.paid, stillToPay: pay.remaining, payment: pay.payment, invoiced: q.invoiced_total, creditedTotal: q.credited_total, dearBalanceDue: q.amount_due },
    leavesTheOpenQuotesListWhen: quoteStage ? 'it is confirmed in DEAR and paid' : pay.remaining > 0.005 ? 'it is paid' : 'it already has (paid and confirmed)',
    followUp: { next: fu.next, manualDate: day(q.follow_up_at), firstDoneOn: day(q.fu1_done_on), secondDoneOn: day(q.fu2_done_on) },
    heldPrepayment: held.map(h => ({ kind: h.kind, amount: h.amount, reserved: h.reserved, freeToReserve: h.free, reservable: h.reservable, released: h.released })),
    creditReservations: reservations.map(x => ({ amount: x.amount, from: x.account, to: x.forAccount, creditNote: x.creditNo, status: x.status, note: clip(x.note, 200) })),
    invoices: docs.slice(0, 20).map(simple), creditNotes: cn.slice(0, 20).map(simple),
    lines: lines.map(l => ({ sku: l.sku, product: l.product, brand: l.brand, qty: l.qty, unitPrice: l.unit_price, discount: l.discount, lineTotal: l.line_total })),
    orderLog: notes.map(n => ({ date: day(n.occurred_at), type: n.type, by: n.rep, note: clip(n.note) })),
    emailsMentioningIt: emails.map(e => ({ date: day(e.occurred_at), direction: /^in/i.test(e.direction) ? 'Received' : 'Sent', by: e.rep, subject: clip(e.subject, 200), preview: clip(e.snippet, 300) })),
  });
}