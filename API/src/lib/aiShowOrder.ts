import * as ts from './tradeshow';

// Taking a trade show order by talking to the assistant. Like the bulk activity log, it never saves on its own: show_order (the tool) only builds a
// PREVIEW, which the chat shows as a table with a Confirm button. Pressing Confirm sends the settled lines to POST /ai/show-order/confirm, which
// starts an ordinary DRAFT order for the rep. It is never confirmed and never emailed from here: the rep opens the draft, checks the offers, freight and
// total, chooses how the customer pays, and confirms it there. Nothing here deletes or edits an existing order.
export const MAX_ITEMS = 60;
export type OrderAsk = { show?: string; customer?: string; accountId?: string; kind?: string; items?: { product?: string; sku?: string; colour?: string; qty?: unknown }[] };
export type Choice = { id: string; label: string };
export type OrderProblem = { what: string; reason: string; choices?: Choice[] };
export type OrderLine = { sku: string; name: string; brand: string | null; qty: number; price: number; lineTotal: number; stock: string; warning: string | null };
export type OrderProposal = { showId: string; showName: string; accountId: string; customer: string; region: string | null; kind: 'order' | 'quote'; lines: OrderLine[]; goods: number; problems: OrderProblem[] };
type Rep = { id: string; role: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const money = (n: number) => n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Which show: the one named, else the one running today, else the only open one. Anything else is a question for the rep. */
export function pickShow(shows: { id: string; name: string; startsOn: string; endsOn: string; archived: boolean }[], asked: string | undefined, today: string): { show?: { id: string; name: string }; problem?: OrderProblem } {
  const open = shows.filter(s => !s.archived);
  const choices = (list: typeof shows) => list.slice(0, 6).map(s => ({ id: s.id, label: `${s.name} (${s.startsOn} to ${s.endsOn})` }));
  const want = norm(asked ?? '');
  if (want) {
    const hit = open.filter(s => norm(s.name).includes(want) || want.includes(norm(s.name)));
    if (hit.length === 1) return { show: hit[0]! };
    return { problem: { what: asked!, reason: hit.length ? 'More than one show matches. Which one?' : 'No open show has that name. Which one?', choices: choices(hit.length ? hit : open) } };
  }
  const day = (d: string, by: number) => new Date(Date.parse(d + 'T00:00:00Z') + by * 86400000).toISOString().slice(0, 10);
  const now = open.filter(s => s.startsOn <= day(today, 1) && s.endsOn >= day(today, -1));
  if (now.length === 1) return { show: now[0]! };
  if (!now.length && open.length === 1) return { show: open[0]! };
  return { problem: { what: 'Which show?', reason: 'Say which trade show this order is for.', choices: choices(now.length ? now : open) } };
}

/** One wanted product: by SKU, or by words (with a colour). One clear match is used; otherwise the rep picks. */
export function pickProduct(hits: ts.ProductHit[], ask: { product?: string; sku?: string; colour?: string }): { hit?: ts.ProductHit; problem?: OrderProblem } {
  const label = [ask.product ?? ask.sku, ask.colour].filter(Boolean).join(' ');
  const choiceOf = (p: ts.ProductHit): Choice => ({ id: p.sku, label: `${p.name} (${p.sku})${p.price === null ? ', no wholesale price' : `, $${money(p.price)}`}, ${Math.max(p.free, 0)} free` });
  if (ask.sku) {
    const exact = hits.find(h => h.sku.toUpperCase() === ask.sku!.toUpperCase());
    return exact ? { hit: exact } : { problem: { what: label, reason: 'No product has that SKU' } };
  }
  if (!hits.length) return { problem: { what: label, reason: 'No product matched' } };
  let pool = hits;
  const colour = norm(ask.colour ?? '');
  if (colour) {
    const coloured = hits.filter(h => ` ${norm(h.name)} ${norm(h.sku)} `.includes(` ${colour} `));
    if (!coloured.length) return { problem: { what: label, reason: `No "${ask.colour}" version found. Here is what matched:`, choices: hits.slice(0, 6).map(choiceOf) } };
    pool = coloured;
  }
  // words from the request must all be in the name (so "bunny small" does not pick "bunny large")
  const words = norm(ask.product ?? '').split(' ').filter(w => w.length > 1);
  const strict = pool.filter(h => words.every(w => ` ${norm(h.name)} ${norm(h.sku)} ${norm(h.brand ?? '')} `.includes(w)));
  if (strict.length) pool = strict;
  if (pool.length === 1) return { hit: pool[0]! };
  return { problem: { what: label, reason: 'More than one product matches. Which one?', choices: pool.slice(0, 6).map(choiceOf) } };
}

const qtyOf = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 10000 ? n : null; };

export async function previewShowOrder(rep: Rep, ask: OrderAsk, today: string): Promise<OrderProposal | { problems: OrderProblem[] }> {
  const problems: OrderProblem[] = [];
  const items = Array.isArray(ask?.items) ? ask.items.filter(i => i && typeof i === 'object') : [];
  if (!items.length) return { problems: [{ what: '(none)', reason: 'No products were given' }] };
  if (items.length > MAX_ITEMS) return { problems: [{ what: '(too many)', reason: `At most ${MAX_ITEMS} products at a time` }] };

  const shows = await ts.listShows();
  const sh = pickShow(shows as any, ask.show, today);
  if (sh.problem) problems.push(sh.problem);

  // the customer: the exact name (or an id already settled); anything else is a pick. Adding a new customer is done on the show page.
  let acct: { id: string; name: string; region: string | null } | null = null;
  if (ask.accountId && UUID.test(ask.accountId)) {
    const hit = (await ts.searchCustomers(ask.customer ?? ask.accountId).catch(() => [])).find(c => c.id === ask.accountId) ?? (await ts.customerById(ask.accountId));
    if (hit) acct = { id: hit.id, name: hit.name, region: hit.region };
  }
  if (!acct) {
    const want = norm(ask.customer ?? '');
    if (!want) problems.push({ what: 'Which customer?', reason: 'Say which customer this order is for.' });
    else {
      const found = await ts.searchCustomers(ask.customer);
      const exact = found.filter(c => norm(c.name) === want);
      if (exact.length === 1) acct = { id: exact[0]!.id, name: exact[0]!.name, region: exact[0]!.region };
      else problems.push(found.length
        ? { what: ask.customer!, reason: exact.length > 1 ? 'More than one customer has exactly this name' : 'No exact match. Which of these?', choices: found.slice(0, 6).map(c => ({ id: c.id, label: `${c.name} (${c.region})` })) }
        : { what: ask.customer!, reason: 'Not found. A new customer is added on the show page (New order, then add a new customer).' });
    }
  }

  const merged = new Map<string, OrderLine>();
  for (const it of items) {
    const qty = qtyOf(it.qty);
    const label = [it.product ?? it.sku, it.colour].filter(Boolean).join(' ') || '(no product)';
    if (!qty) { problems.push({ what: label, reason: 'The quantity must be a whole number, 1 or more' }); continue; }
    if (!(it.product ?? it.sku)) { problems.push({ what: label, reason: 'No product was given' }); continue; }
    const hits = await ts.searchProducts(it.sku ?? [it.product, it.colour].filter(Boolean).join(' '));
    // a colour in the words may have hidden the plain name, so try the name alone too
    const all = it.colour && !it.sku ? [...hits, ...(await ts.searchProducts(it.product))].filter((h, i, a) => a.findIndex(x => x.sku === h.sku) === i) : hits;
    const r = pickProduct(all, it);
    if (r.problem) { problems.push(r.problem); continue; }
    const p = r.hit!;
    if (p.price === null) { problems.push({ what: p.name, reason: 'It has no wholesale price, so it cannot go on an order' }); continue; }
    const have = merged.get(p.sku.toUpperCase());
    const total = (have?.qty ?? 0) + qty;
    const warn: string[] = [];
    if (p.increment && p.increment > 1 && total % p.increment) warn.push(`Sold in packs of ${p.increment}`);
    if (p.free < total) warn.push(p.free > 0 ? `Only ${p.free} free in stock` : 'None free in stock');
    merged.set(p.sku.toUpperCase(), { sku: p.sku, name: p.name, brand: p.brand, qty: total, price: p.price, lineTotal: round2(total * p.price), stock: `${Math.max(p.free, 0)} free`, warning: warn.join('. ') || null });
  }

  const lines = [...merged.values()];
  if (!sh.show || !acct || !lines.length) return { problems };
  const goods = round2(lines.reduce((a, l) => a + l.lineTotal, 0));
  return { showId: sh.show.id, showName: sh.show.name, accountId: acct.id, customer: acct.name, region: acct.region, kind: ask.kind === 'quote' ? 'quote' : 'order', lines, goods, problems };
}

/** Pressing Confirm: starts a DRAFT order and puts the lines on it. If the lines are refused the empty draft is thrown away, so nothing is left half made. */
export async function createDraft(rep: Rep, b: any): Promise<{ orderId: string; number: string }> {
  const showId = String(b?.showId ?? ''), accountId = String(b?.accountId ?? '');
  if (!UUID.test(showId) || !UUID.test(accountId)) throw new ts.TsError('Something was missing. Ask the assistant to prepare the order again.');
  const lines = Array.isArray(b?.lines) ? b.lines : [];
  if (!lines.length || lines.length > MAX_ITEMS) throw new ts.TsError('There are no products to put on the order.');
  const clean = lines.map((l: any) => ({ sku: String(l?.sku ?? '').slice(0, 64), qty: qtyOf(l?.qty) })).filter((l: any) => l.sku && l.qty);
  if (clean.length !== lines.length) throw new ts.TsError('A product or quantity was not valid. Ask the assistant to prepare the order again.');
  const orderId = await ts.startOrder(rep, { showId, accountId, kind: b?.kind === 'quote' ? 'quote' : 'order' });
  try {
    await ts.saveOrder(rep, orderId, { lines: clean.map((l: any) => ({ sku: l.sku, qty: l.qty, comment: '', kind: 'normal', offerId: null })) });
  } catch (e) {
    await ts.cancelOrder(rep, orderId, 'assistant could not add the lines').catch(() => undefined);   // a draft is simply thrown away
    throw e;
  }
  const o = await ts.getOrder(orderId);
  return { orderId, number: o.number };
}

// What the assistant is told after it builds a preview. It never sees "saved".
export function orderSummary(p: OrderProposal | { problems: OrderProblem[] }) {
  if (!('lines' in p)) return { previewShownToPerson: false, savedNothing: true, problems: p.problems, note: 'Nothing is ready yet. Ask the person for what is missing or which one they mean (use the choices), then call show_order again with the COMPLETE list (use sku for products already settled and accountId for a customer already settled).' };
  return {
    previewShownToPerson: true, savedNothingYet: true, show: p.showName, customer: p.customer, kind: p.kind, lines: p.lines.map(l => ({ sku: l.sku, name: l.name, qty: l.qty, warning: l.warning })), goodsExGst: p.goods, problems: p.problems,
    note: 'A table with a Create draft button is shown in the chat. NOTHING is saved until the person presses it, and even then only a DRAFT is made: the rep opens it to check offers, freight and the total, choose how the customer pays and confirm. Do not say the order is placed or sent. Tell them what is in the preview, mention any warnings and problems, and ask them to check it. For anything with a problem, ask which one they mean, then call show_order again with the COMPLETE list.',
  };
}
