// Builds sandbox-seed.sql: a small, MADE-UP business to fill an EMPTY sandbox database. Nothing here is real: every shop, person, product and number is invented.
// The same program always writes the same file. Dates are written relative to the day the file is RUN, so the sandbox always looks current.
import { writeFileSync } from 'node:fs';

// ---------- a small deterministic random number generator ----------
let seedState = 20261030;
const rnd = () => { seedState |= 0; seedState = (seedState + 0x6D2B79F5) | 0; let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const chance = p => rnd() < p;
const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const hex = n => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[ri(0, 3)]}${hex(3)}-${hex(12)}`;
const r2 = n => Math.round(n * 100) / 100;
const q = s => (s === null || s === undefined) ? 'null' : `'${String(s).replace(/'/g, "''")}'`;
const n_ = v => (v === null || v === undefined) ? 'null' : String(v);
const D = n => `(current_date - ${n})`;                       // a date, n days ago
const TS = n => `((current_date - ${n})::timestamp)`;          // midnight, n days ago (the app stores an order's day as 00:00)
const TSH = (n, h, m) => `((current_date - ${n})::timestamp + interval '${h} hours ${m} minutes')`;
const ago = n => `(now() - interval '${n} days')`;
const rows = (table, cols, vals, chunk = 80) => { const out = []; for (let i = 0; i < vals.length; i += chunk) out.push(`insert into crm.${table} (${cols}) values\n${vals.slice(i, i + chunk).join(',\n')};`); return out.join('\n'); };

// ---------- the made-up cast ----------
const FIRST = ['Sandra', 'Tom', 'Joan', 'Lucy', 'Ben', 'Ruth', 'Priya', 'Colin', 'Mei', 'Frank', 'Alice', 'Gary', 'Hannah', 'Leon', 'Vera', 'Omar', 'Grace', 'Nick', 'Fiona', 'Raj', 'Chloe', 'Dean', 'Isla', 'Marcus', 'Tess', 'Paul', 'Nina', 'Hugh', 'Zoe', 'Ian'];
const LAST = ['Cole', 'Hendry', 'Maher', 'Park', 'Aitken', 'Evans', 'Nair', 'Ward', 'Tan', 'Doyle', 'Brown', 'Lim', 'Moss', 'Cruz', 'Hall', 'Singh', 'Reid', 'Webb', 'Long', 'Shah', 'Price', 'Hart', 'Boyd', 'Frost', 'Lowe', 'Ellis', 'Gray', 'Cook', 'Ross', 'Dunn'];
const SHOP_A = ['Mulberry Lane', 'Bluebird', 'Willow', 'Wattle', 'Pebble', 'Kookaburra', 'Fig Tree', 'Harbour Street', 'Little Acorn', 'Seaview', 'Corner Cupboard', 'Daisy Chain', 'Tuckerbox', 'Old Mill', 'Gum Leaf', 'Honeybee', 'Lantern', 'Paper Kite', 'Saltbush', 'Magpie', 'Bellbird', 'Copper Kettle', 'Ironbark', 'Lavender', 'Marigold', 'Quokka', 'Rosella', 'Sunbird', 'Thistle', 'Wombat', 'Yarra', 'Banksia', 'Coral Cove', 'Driftwood', 'Emu Plains', 'Fern Gully', 'Gumnut', 'Heron', 'Ivy House', 'Jasmine', 'Kelp', 'Lilly Pilly', 'Moonrise', 'Nutmeg', 'Olive Grove', 'Poppy', 'Quince', 'Reed', 'Sparrow', 'Tulip', 'Violet', 'Waratah', 'Zinnia', 'Blossom', 'Cedar', 'Dune', 'Ember', 'Flint', 'Granite', 'Bramble', 'Clover', 'Dragonfly', 'Foxglove', 'Hollyhock', 'Larkspur', 'Meadow', 'Pelican', 'Sandpiper', 'Wren'];
const SHOP_B = ['Gifts', 'Books', 'Toys', 'Homewares', 'Stationers', 'Emporium', 'Boutique', 'Cards', 'Treasures', 'Giftware', 'Kids', 'Trading Post', 'Gift Garden', 'General Store'];
const CATEGORY = ['Gift shop', 'Toy store', 'Bookshop', 'Homewares', 'Newsagent', 'Boutique', 'Garden centre', 'Card shop'];
const STATES = { 1: [['VIC', 0.75, [['Daylesford', '3460'], ['Ballarat', '3350'], ['Geelong', '3220'], ['Bendigo', '3550'], ['Fitzroy', '3065']]], ['TAS', 0.25, [['Launceston', '7250'], ['Hobart', '7000']]]],
                 2: [['NSW', 0.85, [['Bowral', '2576'], ['Newcastle', '2300'], ['Parramatta', '2150'], ['Wollongong', '2500']]], ['ACT', 0.15, [['Kingston', '2604']]]],
                 3: [['QLD', 1, [['Noosa Heads', '4567'], ['Toowoomba', '4350'], ['Cairns', '4870'], ['Paddington', '4064']]]],
                 4: [['SA', 0.6, [['Hahndorf', '5245'], ['Glenelg', '5045']]], ['WA', 0.4, [['Fremantle', '6160'], ['Margaret River', '6285']]]] };
const COUNCIL = { 3460: 'Hepburn', 3350: 'Ballarat', 3220: 'Greater Geelong', 3550: 'Greater Bendigo', 3065: 'Yarra', 7250: 'Launceston', 7000: 'Hobart', 2576: 'Wingecarribee', 2300: 'Newcastle', 2150: 'Parramatta', 2500: 'Wollongong', 2604: 'South Canberra', 4567: 'Noosa', 4350: 'Toowoomba', 4870: 'Cairns', 4064: 'Brisbane', 5245: 'Adelaide Hills', 5045: 'Holdfast Bay', 6160: 'Fremantle', 6285: 'Augusta-Margaret River' };
const STREET = ['High Street', 'Main Road', 'Station Street', 'Market Lane', 'Church Street', 'Beach Road', 'Mill Street', 'Park Avenue'];

// ---------- products ----------
const BRANDS = [
  { name: 'Petal & Co', pre: 'PET', cat: 'Party', items: ['Birthday Candle Set', 'Number Candle', 'Sparkler Candles', 'Cake Topper', 'Party Hats 8 pack', 'Paper Plates 12 pack', 'Napkins 20 pack', 'Party Blowers'], inc: 6, w: [3, 14] },
  { name: 'Little Fox Paper', pre: 'LFP', cat: 'Gift wrap', items: ['Gift Wrap Roll', 'Gift Tags 20 pack', 'Greeting Card', 'Tissue Paper 10 sheet', 'Ribbon Spool', 'Gift Bag Medium'], inc: 12, w: [1.5, 9] },
  { name: 'Confetti Lane', pre: 'CFL', cat: 'Party', items: ['Foil Balloon Set', 'Paper Straws 24 pack', 'Bunting', 'Confetti Pot', 'Banner Letters', 'Latex Balloons 12 pack'], inc: 12, w: [2, 11] },
  { name: 'Wren & Willow', pre: 'WRW', cat: 'Kids', items: ['Soft Toy Small', 'Jigsaw Puzzle 48 piece', 'Colouring Set', 'Wooden Stacker', 'Play Dough Pack', 'Story Book'], inc: 4, w: [6, 32] },
  { name: 'Harbour Home', pre: 'HBH', cat: 'Homewares', items: ['Scented Candle', 'Tea Towel', 'Ceramic Mug', 'Tea Light Holder', 'Tote Bag', 'Notebook A5'], inc: 6, w: [5, 26] },
  { name: 'Kite & Cloud', pre: 'KTC', cat: 'Toys', items: ['Diamond Kite', 'Bubble Wand Set', 'Skipping Rope', 'Card Game', 'Spinning Top', 'Beach Ball'], inc: 12, w: [3, 18] }];
const VARIANT = ['Gold', 'Silver', 'Pink', 'Rainbow', 'Spring', 'Floral', 'Stripe', 'Spot', 'Mint', 'Navy', 'Sunshine', 'Berry'];
const products = [];
let pn = 1000;
for (const b of BRANDS) for (const item of b.items) for (const v of shuffle(VARIANT).slice(0, chance(0.5) ? 3 : 2)) {
  const w = r2(ri(b.w[0] * 2, b.w[1] * 2) / 2); const retail = r2(Math.ceil(w * 2.05) - 0.05);
  products.push({ sku: `${b.pre}-${++pn}`, name: `${v} ${item}`, brand: b.name, category: b.cat, inc: b.inc, w, retail, cost: r2(w * (0.42 + rnd() * 0.12)), pop: Math.pow(rnd(), 2.2) + 0.03, life: null, scarce: false });
}
products.forEach((p, i) => { p.i = i; });
const byLife = shuffle(products); byLife.slice(0, 7).forEach(p => { p.life = 'deprecated'; p.pop *= 0.3; }); byLife.slice(7, 10).forEach(p => { p.life = 'discontinued'; p.pop *= 0.1; }); byLife.slice(10, 13).forEach(p => { p.life = 'eol'; p.pop *= 0.4; });
const popular = [...products].filter(p => !p.life).sort((a, b) => b.pop - a.pop);
popular.slice(0, 8).forEach(p => { p.scarce = true; });                    // best sellers that are out of stock, with customers waiting
const weights = products.map(p => (p.life === 'discontinued' ? 0 : p.pop));
const pickProduct = (pool = products) => { const ws = pool.map(p => (p.life === 'discontinued' ? 0 : p.pop)); let r = rnd() * ws.reduce((a, b) => a + b, 0); for (let i = 0; i < pool.length; i++) { r -= ws[i]; if (r <= 0) return pool[i]; } return pool[pool.length - 1]; };

// ---------- accounts ----------
const names = shuffle(SHOP_A.flatMap(a => SHOP_B.map(b => `${a} ${b}`))).slice(0, 80);
const accounts = [];
const spec = [['customer', 'prepay', 36], ['customer', 'account', 12], ['lead', 'prepay', 8], ['prospect', 'prepay', 8], ['cold_lead', 'prepay', 4], ['customer', 'prepay', 4]];   // the last 4 are archived
let ni = 0;
for (const [type, credit, count] of spec) for (let k = 0; k < count; k++) {
  const slot = ri(1, 4); const [state, , towns] = (() => { let r = rnd(), acc = 0; for (const s of STATES[slot]) { acc += s[1]; if (r <= acc) return s; } return STATES[slot][0]; })();
  const [suburb, postcode] = pick(towns);
  const stage = type === 'customer' ? 'dispatched' : type === 'lead' ? pick(['new_lead', 'approached', 'quote_sent']) : 'new_lead';
  accounts.push({ id: uuid(), name: names[ni++], type, credit, stage, slot, state, archived: spec.length - 1 === spec.findIndex(s => s === [type, credit, count]) ? false : false, contact: `${pick(FIRST)} ${pick(LAST)}`, suburb, postcode, street: `${ri(2, 140)} ${pick(STREET)}`, category: pick(CATEGORY), orders: [], gap: ri(22, 95), terms: credit === 'prepay' ? 'Prepayment' : pick(['30 Days EOM', '14 Days', '30 Days']) });
}
accounts.slice(-4).forEach(a => { a.archived = true; });
accounts.forEach((a, i) => { a.phone = `${a.state === 'NSW' || a.state === 'ACT' ? '02' : a.state === 'QLD' ? '07' : a.state === 'SA' || a.state === 'WA' ? '08' : '03'} 5550 ${String(100 + i).padStart(4, '0')}`; a.email = `orders${i + 1}@example.com`; });

// ---------- orders ----------
const allOrdersEarly = () => accounts.flatMap(a => a.orders);
let orderNo = 40000;
const DEAD = new Set(['DRAFT', 'ESTIMATING', 'ESTIMATED', 'ORDERING', 'VOIDED', 'CREDITED', 'QUOTE']);
const counts = o => !DEAD.has(o.status) && o.live;
function makeLines(acct, scarceOnly = false, sizeHint = 0) {
  const n = sizeHint || ri(1, 9); const seen = new Set(); const lines = [];
  while (lines.length < n) {
    const p = scarceOnly ? pick(products.filter(x => x.scarce)) : pickProduct(products.filter(x => !x.scarce || chance(0.25)));
    if (seen.has(p.sku)) continue; seen.add(p.sku);
    const qty = p.inc * ri(1, p.inc >= 12 ? 4 : 6); const disc = chance(0.12) ? 5 : 0;
    const unit = p.w; const total = r2(qty * unit * (1 - disc / 100));
    lines.push({ sku: p.sku, name: p.name, brand: p.brand, qty, unit, disc, total, tax: r2(total * 0.1) });
  }
  return lines;
}
function addOrder(acct, daysAgo, status, o = {}) {
  const lines = o.lines ?? makeLines(acct, o.scarce);
  const amount = r2(lines.reduce((t, l) => t + l.total, 0)); const tax = r2(amount * 0.1); const total = r2(amount + tax);
  const order = { id: uuid(), acct, number: o.history ? `Q${ri(9000, 9999)}${ri(10, 99)}` : `SQ${++orderNo}`, live: !o.history, history: !!o.history, days: daysAgo, status, lines, amount, tax, total, ...o };
  acct.orders.push(order); return order;
}
const shippedFields = o => { o.shipping = 'SHIPPED'; o.picking = 'PICKED'; o.ful = [{ pick: 'PICKED', pack: 'PACKED', ship: 'SHIPPED' }]; };
function settle(o, mode) {                                                   // mode: paid | unpaid | part
  const inv = Math.max(0, o.days - ri(1, 3)); o.invDays = inv; o.invNo = `INV-${50000 + ri(1, 9000)}`;
  if (mode === 'paid') { o.paid = true; o.amountPaid = o.total; o.due = 0; o.paidDays = Math.max(0, o.days - ri(0, 3)); }
  else if (mode === 'part') { o.paid = false; o.amountPaid = r2(o.total * 0.5); o.due = r2(o.total - o.amountPaid); }
  else { o.paid = false; o.amountPaid = 0; o.due = o.total; }
  o.invoiced = o.total; o.paySt = mode === 'paid' ? 'PAID' : mode === 'part' ? 'PARTIALLY PAID' : 'UNPAID';
  const dueIn = o.acct.credit === 'prepay' ? 0 : (parseInt(o.acct.terms) || 30);
  o.invoices = [{ number: o.invNo, date: new Date(Date.now() - inv * 864e5).toISOString().slice(0, 10), dueDate: new Date(Date.now() - (inv - dueIn) * 864e5).toISOString().slice(0, 10), total: o.total, paid: o.amountPaid, due: o.due, status: mode === 'paid' ? 'PAID' : 'AUTHORISED' }];
}
const customers = accounts.filter(a => a.type === 'customer');
customers.forEach((a, idx) => {
  const lapsed = idx % 9 === 0, overdue = idx % 6 === 3, due = idx % 5 === 2;
  const endDay = lapsed ? ri(200, 380) : overdue ? Math.round(a.gap * (1.6 + rnd())) : due ? Math.round(a.gap * (0.85 + rnd() * 0.5)) : ri(1, Math.max(2, Math.round(a.gap * 0.7)));
  let day = endDay; const first = ri(0, 2);
  while (day <= 470 + first * 30) {
    const o = addOrder(a, day, 'COMPLETED'); shippedFields(o);
    const mode = a.credit === 'account' && day < 35 ? (chance(0.7) ? 'unpaid' : 'paid') : a.credit === 'account' && day > 60 && day < 100 && chance(0.12) ? 'unpaid' : 'paid';
    settle(o, mode);
    if (chance(0.04) && day > 20) { o.status = 'VOIDED'; o.shipping = 'NOT SHIPPED'; o.picking = null; o.ful = []; o.paid = false; o.amountPaid = 0; o.due = 0; o.invoiced = 0; o.invoices = []; o.paySt = 'UNPAID'; }
    else if (chance(0.025) && day > 20) { o.status = 'CREDITED'; }
    day += Math.max(8, Math.round(a.gap * (0.7 + rnd() * 0.6)));
  }
});
// recent orders in every stage, for customers that are still ordering
const active = customers.filter(a => a.orders.length && Math.min(...a.orders.map(o => o.days)) < 60);
shuffle(active).slice(0, 14).forEach(a => { const o = addOrder(a, ri(1, 12), 'AUTHORISED'); o.shipping = 'NOT SHIPPED'; o.picking = 'NOT PICKED'; o.ful = []; if (a.credit === 'prepay') { if (chance(0.5)) { settle(o, 'paid'); o.invoices = []; o.invoiced = null; } else { o.paid = false; o.amountPaid = 0; o.due = o.total; o.paySt = 'UNPAID'; } } else { o.paid = false; o.amountPaid = 0; o.due = null; o.paySt = 'UNPAID'; } o.allocated = true; });
shuffle(active).slice(0, 6).forEach(a => { const o = addOrder(a, ri(1, 6), 'AUTHORISED'); o.picking = 'PICKED'; o.shipping = 'NOT SHIPPED'; o.ful = [{ pick: 'PICKED' }]; o.paid = true; o.amountPaid = o.total; o.due = 0; o.paySt = 'PAID'; o.allocated = true; });
shuffle(active).slice(0, 6).forEach(a => { const o = addOrder(a, ri(3, 20), 'BACKORDERED', { scarce: true, lines: makeLines(a, true, ri(1, 3)) }); o.shipping = 'NOT SHIPPED'; o.picking = 'NOT PICKED'; o.ful = []; o.paid = a.credit === 'prepay'; o.amountPaid = o.paid ? o.total : 0; o.due = o.paid ? 0 : o.total; o.paySt = o.paid ? 'PAID' : 'UNPAID'; o.backordered = true; o.lf = Object.fromEntries(o.lines.map(l => [l.sku, { backordered: l.qty, shipped: 0 }])); });
// open quotes: unpaid orders and quotes that the team is chasing (some old, some new), for pay-first customers
const prepayActive = customers.filter(a => a.credit === 'prepay' && !a.archived);
const openAges = [6, 9, 14, 19, 26, 33, 41, 58, 77, 96, 121, 150, 190, 241, 290, 330, 365, 12, 22, 45, 70];
shuffle(prepayActive).slice(0, openAges.length).forEach((a, i) => {
  const age = openAges[i]; const status = pick(['ORDERING', 'ORDERING', 'ESTIMATED', 'AUTHORISED']);
  const o = addOrder(a, age, status); o.shipping = 'NOT SHIPPED'; o.picking = 'NOT PICKED'; o.ful = []; o.paid = false; o.amountPaid = 0; o.due = status === 'AUTHORISED' ? o.total : null; o.paySt = 'UNPAID'; o.open = true;
  if (chance(0.15) && status === 'AUTHORISED') { o.amountPaid = r2(o.total * 0.4); o.due = r2(o.total - o.amountPaid); o.paySt = 'PARTIALLY PAID'; }
  if (age > 14 && chance(0.8)) o.fu1 = Math.max(0, age - ri(8, 13));
  if (o.fu1 !== undefined && age > 40 && chance(0.7)) o.fu2On = Math.min(Math.max(-20, Math.round(age * rnd() * 0.9) - 6), o.fu1 - 1);   // the 2nd date comes after the 1st was done (fewer days ago)
  if (o.fu2On !== undefined && age > 150 && chance(0.15)) o.fu2Done = Math.max(0, o.fu2On - ri(0, 6));
});
// a few second follow-ups that are still to come (dates in the future), so the list shows both overdue and upcoming
allOrdersEarly().filter(o => o.fu2On !== undefined && o.fu2Done === undefined).slice(0, 4).forEach((o, i) => { o.fu2On = -ri(2 + i, 12 + i * 2); });
// a few older "history" orders, from before the system change
shuffle(customers).slice(0, 16).forEach(a => { for (let k = 0; k < ri(1, 3); k++) { const o = addOrder(a, ri(520, 900), 'COMPLETED', { history: true }); shippedFields(o); o.source = 'rhino-history'; settle(o, 'paid'); o.invoices = []; } });
// a few leads with a first quote
accounts.filter(a => a.type === 'lead' && a.stage !== 'new_lead').forEach(a => { const o = addOrder(a, ri(3, 40), a.stage === 'quote_sent' ? 'ESTIMATED' : 'ORDERING'); o.shipping = 'NOT SHIPPED'; o.picking = 'NOT PICKED'; o.ful = []; o.paid = false; o.amountPaid = 0; o.due = null; o.paySt = 'UNPAID'; o.open = true; });

// ---------- customer figures, worked out from the orders (counting sales only) ----------
for (const a of accounts) {
  const s = a.orders.filter(counts).sort((x, y) => x.days - y.days);
  a.spend30 = r2(s.filter(o => o.days <= 30).reduce((t, o) => t + o.amount, 0));
  a.spend90 = r2(s.filter(o => o.days <= 90).reduce((t, o) => t + o.amount, 0));
  a.spend365 = r2(s.filter(o => o.days <= 365).reduce((t, o) => t + o.amount, 0));
  a.lastDays = s.length ? s[0].days : null;
  if (s.length > 1) { const gaps = []; for (let i = 0; i < s.length - 1; i++) gaps.push(s[i + 1].days - s[i].days); a.avgGap = Math.round(gaps.reduce((x, y) => x + y, 0) / gaps.length); } else a.avgGap = null;
  a.createdDays = (s.length ? s[s.length - 1].days : ri(5, 120)) + ri(5, 60);
}

// ---------- purchase orders ----------
const sold365 = new Map(); for (const a of accounts) for (const o of a.orders) if (counts(o) && o.days <= 365) for (const l of o.lines) sold365.set(l.sku, (sold365.get(l.sku) ?? 0) + l.qty);
products.forEach(p => { p.rate = (sold365.get(p.sku) ?? 0) / 12; });
const pos = []; let poNo = 100;
const suppliers = BRANDS.map(b => `${b.name} Trading`);
for (let i = 0; i < 7; i++) {   // finished: ordered long ago and fully received
  const b = pick(BRANDS); const items = shuffle(products.filter(p => p.brand === b.name)).slice(0, ri(4, 8));
  const od = ri(110, 330); pos.push({ id: `po-${++poNo}`, number: `PO-${String(poNo).padStart(5, '0')}`, supplier: `${b.name} Trading`, status: 'COMPLETED', recv: 'FULLY RECEIVED', orderDays: od, reqDays: od - ri(40, 70), lines: items.map(p => ({ p, ord: Math.max(p.inc, Math.round(Math.max(p.rate, 5) * ri(3, 5) / p.inc) * p.inc) })), mode: 'full' });
}
const lowCover = products.filter(p => !p.life && !p.scarce && p.rate > 8);
const outstanding = [{ mode: 'open', req: 24 }, { mode: 'open', req: 38 }, { mode: 'open', req: 55 }, { mode: 'open', req: 70 }, { mode: 'part', req: 9 }, { mode: 'part', req: 17 }, { mode: 'late', req: -12 }];
outstanding.forEach((x, i) => {
  const brandPool = shuffle(BRANDS).slice(0, 1)[0]; const pool = shuffle([...lowCover.filter(p => p.brand === brandPool.name), ...products.filter(p => p.scarce && p.brand === brandPool.name)]); const items = (pool.length >= 3 ? pool : shuffle(lowCover)).slice(0, ri(4, 9));
  pos.push({ id: `po-${++poNo}`, number: `PO-${String(poNo).padStart(5, '0')}`, supplier: `${brandPool.name} Trading`, status: 'ORDERED', recv: x.mode === 'part' ? 'PARTIALLY RECEIVED' : 'NOT RECEIVED', orderDays: ri(25, 75), reqDays: -x.req, lines: items.map(p => ({ p, ord: Math.max(p.inc, Math.round(Math.max(p.rate, 8) * ri(3, 5) / p.inc) * p.inc) })), mode: x.mode });
});
const onOrder = new Map(), etaOf = new Map();
for (const po of pos) for (const l of po.lines) {
  l.recv = po.mode === 'full' ? l.ord : po.mode === 'part' ? Math.round(l.ord * 0.4 / l.p.inc) * l.p.inc : 0;
  const out = l.ord - l.recv; if (out > 0) { onOrder.set(l.p.sku, (onOrder.get(l.p.sku) ?? 0) + out); const e = etaOf.get(l.p.sku); if (e === undefined || -po.reqDays < e) etaOf.set(l.p.sku, -po.reqDays); }
}

// ---------- stock, worked out from orders and purchases ----------
const allocated = new Map(); for (const a of accounts) for (const o of a.orders) if (o.allocated) for (const l of o.lines) allocated.set(l.sku, (allocated.get(l.sku) ?? 0) + l.qty);
const backord = new Map(); for (const a of accounts) for (const o of a.orders) if (o.backordered) for (const l of o.lines) backord.set(l.sku, (backord.get(l.sku) ?? 0) + l.qty);
for (const p of products) {
  const alloc = allocated.get(p.sku) ?? 0; let base;
  if (p.life === 'discontinued' || p.scarce) base = 0;
  else if (p.rate <= 0.01) base = ri(0, 90);
  else { const r = rnd(); const cover = r < 0.25 ? 0.4 + rnd() * 1.4 : r < 0.65 ? 2.5 + rnd() * 3.5 : r < 0.9 ? 7 + rnd() * 5 : 13 + rnd() * 17; base = Math.round(p.rate * cover / p.inc) * p.inc; }
  p.onHand = p.scarce ? 0 : base + alloc; p.alloc = p.scarce ? 0 : alloc; p.avail = p.onHand - p.alloc; p.onOrder = onOrder.get(p.sku) ?? 0; p.eta = etaOf.get(p.sku);
}

// ---------- activity and tasks ----------
const NOTES = { call: ['Rang to check in. Happy with the range, will order after the school holidays.', 'Left a message about the new season range.', 'Spoke to the owner. Asked for the updated price list.', 'Customer is chasing a delivery. Told her it ships Thursday.', 'Quick call to confirm the order is paid and on its way.', 'Rang accounts about payment. They will pay on Friday.', 'Asked if they want to add the new candle set to their next order.'],
                email: ['Sent the new price list and the order form.', 'Emailed photos of the spring range.', 'Sent a reminder about the open quote.', 'Followed up on our visit with the catalogue.', 'Sent the invoice again, as asked.'],
                visit: ['Visited the shop. New front window display. Asked about the gold candles.', 'Dropped off samples. Owner loved the wrap rolls.', 'Shop was busy. Left a catalogue and my card.', 'Walked through the range with the buyer. Order to follow.', 'Checked their shelves: low on party hats and straws.'],
                remark: ['Prefers deliveries before 11am.', 'Closed on Mondays.', 'Owner is away until next month. Ask for Sam.', 'Pays by bank transfer, usually within a week.', 'Wants to be told first about new arrivals.'] };
const activity = [];
for (const a of accounts) {
  const n = a.archived ? 1 : a.type === 'customer' ? ri(2, 7) : a.type === 'lead' ? ri(1, 4) : ri(0, 2);
  for (let k = 0; k < n; k++) { const t = pick(['call', 'call', 'email', 'visit', 'remark']); const d = Math.round(Math.pow(rnd(), 1.7) * 210); activity.push({ a, t, d, h: ri(8, 17), m: ri(0, 59), note: pick(NOTES[t]) }); }
  for (const o of a.orders) if (o.open && chance(0.55)) activity.push({ a, t: pick(['call', 'email']), d: Math.max(0, o.days - ri(1, 8)), h: ri(8, 17), m: ri(0, 59), note: pick(['Rang accounts about payment. They will pay on Friday.', 'Sent a reminder about the open quote.', 'Customer promised to pay next week.', 'Waiting on stock before they pay.']), quote: o });
}
const tasks = [];
const repSlots = [1, 2, 3, 4];
for (const slot of repSlots) {
  const mine = accounts.filter(a => a.slot === slot && !a.archived);
  const inactive = mine.filter(a => a.type === 'customer' && a.lastDays !== null && a.lastDays > a.gap * 1.3).sort((x, y) => y.lastDays - x.lastDays).slice(0, 6);
  const fresh = mine.filter(a => a.type === 'lead' || a.type === 'prospect').slice(0, 4);
  [...inactive.map((a, i) => ({ a, type: ['cold_call', 'visit', 'cold_call', 'email', 'cold_call', 'visit'][i], reason: 'inactive' })), ...fresh.map((a, i) => ({ a, type: ['email', 'cold_call', 'visit', 'email'][i], reason: 'new_lead' }))].forEach((t, i) => tasks.push({ ...t, done: i === 1 || i === 7 }));
}

// ---------- write the SQL ----------
const out = [];
out.push(`-- SANDBOX SEED: a small, MADE-UP business. Nothing here is real. Generated by build-seed.mjs; the same program always writes the same file.
-- Run it ONCE, in an EMPTY sandbox database that already has the structure (sandbox-schema.sql) and at least two sign-in users (Authentication, Users).
-- It refuses to run anywhere that already has customers or orders, so it cannot touch real data.
begin;
do $$ begin
  if (select count(*) from crm.accounts) > 0 or (select count(*) from crm.quotes) > 0 or (select count(*) from crm.products) > 0 then
    raise exception 'STOPPED: this database already has customers, orders or products. The sandbox seed only fills an EMPTY sandbox, so it will not run here.';
  end if;
  if (select count(*) from auth.users) < 2 then
    raise exception 'STOPPED: create at least two sign-in users first (Supabase, Authentication, Users, Add user), then run this again.';
  end if;
end $$;

-- the sign-in users become the staff: the first one is the manager, the next ones are sales reps
create temp table seed_staff on commit drop as select id, email, row_number() over (order by created_at, id) as n from auth.users limit 5;
create temp table seed_names (n int, name text) on commit drop;
insert into seed_names values (1, 'Sam Rivers (manager)'), (2, 'Margaret Wilson'), (3, 'David Chen'), (4, 'Priya Nair'), (5, 'Tom Hendry');
insert into crm.reps (id, name, type, role, email)
  select s.id, n.name, 'field'::crm."RepType", case when s.n = 1 then 'manager' else 'rep' end::crm."RepRole", s.email from seed_staff s join seed_names n on n.n = s.n;
create temp table seed_slot (slot int, rep_id uuid) on commit drop;
insert into seed_slot select g, (select id from seed_staff where n = 2 + ((g - 1) % greatest((select count(*) from seed_staff) - 1, 1))) from generate_series(1, 4) g;
update seed_slot set rep_id = (select id from seed_staff where n = 1) where rep_id is null;

insert into crm.product_statuses (key, label, meaning, tone, system, sort_order) values
  ('new', 'New', 'Just added to the range', 'teal', false, 10), ('core', 'Core range', 'Always stocked', 'teal', false, 20), ('seasonal', 'Seasonal', 'Only for part of the year', 'amber', false, 30),
  ('clearance', 'Clearance', 'Selling down at a lower price', 'amber', false, 40), ('deprecated', 'Deprecated', 'Not being reordered', 'rust', false, 50),
  ('eol', 'End of life', 'Sell what is left, then stop', 'rust', true, 60), ('discontinued', 'Discontinued', 'No longer sold', 'rust', true, 70), ('limited', 'Limited edition', 'One run only', 'neutral', false, 80);
`);
const pcs = [...new Map(accounts.map(a => [`${a.postcode}|${a.state}`, a])).values()];
out.push(rows('postcode_councils', 'postcode, state, council, share', pcs.map(a => `(${q(a.postcode)}, ${q(a.state)}, ${q(COUNCIL[a.postcode])}, 1)`)));
out.push(rows('accounts', 'id, name, region, rep_id, credit, type, stage, spend_30, spend_90, spend_365, last_order_at, created_at, updated_at, contact_name, email, phone, address, dear_customer_id, avg_order_gap_days, archived, category, payment_terms, reorder_gap_auto, misc, needs_order_backfill',
  accounts.map(a => `(${q(a.id)}, ${q(a.name)}, ${q(a.state)}, (select rep_id from seed_slot where slot = ${a.slot}), ${q(a.credit)}, ${q(a.type)}, ${q(a.stage)}, ${a.spend30}, ${a.spend90}, ${a.spend365}, ${a.lastDays === null ? 'null' : TS(a.lastDays)}, ${TS(a.createdDays)}, now(), ${q(a.contact)}, ${q(a.email)}, ${q(a.phone)}, ${q(`${a.street}, ${a.suburb} ${a.state} ${a.postcode}`)}, ${a.type === 'customer' ? q('sandbox-' + a.id.slice(0, 8)) : 'null'}, ${n_(a.avgGap)}, ${a.archived}, ${q(a.category)}, ${q(a.terms)}, ${n_(a.avgGap)}, false, false)`)));
out.push('insert into crm.rep_regions (id, rep_id, region) select gen_random_uuid(), rep_id, region from (select distinct rep_id, region from crm.accounts) d;');
out.push(rows('products', 'sku, dear_id, name, brand, category, uom, status, on_hand, allocated, available, on_order, locations, updated_at, stock_synced_at, prices, barcode, attributes, sheet_data, eta, lifecycle, order_increment, weight_kg, tags',
  products.map(p => `(${q(p.sku)}, ${q('sandbox-' + p.sku)}, ${q(p.name)}, ${q(p.brand)}, ${q(p.category)}, 'Each', ${q(p.life ? 'Deprecated' : 'Active')}, ${p.onHand}, ${p.alloc}, ${p.avail}, ${p.onOrder}, ${q(JSON.stringify([{ location: 'Main Warehouse', onHand: p.onHand, allocated: p.alloc, available: p.avail, onOrder: p.onOrder }]))}::jsonb, now(), now(), ${q(JSON.stringify({ Wholesale: p.w, Retail: p.retail }))}::jsonb, ${q('93' + String(1000000000 + p.i * 7919).slice(-10))}, '{}'::jsonb, '{}'::jsonb, ${p.eta === undefined ? 'null' : D(-p.eta)}, ${q(p.life)}, ${p.inc}, ${r2(0.05 + rnd() * 0.8)}, ARRAY[]::text[])`)));
out.push(rows('product_costs', 'sku, average_cost, costing_method', products.map(p => `(${q(p.sku)}, ${p.cost}, 'FIFO')`)));
const allOrders = accounts.flatMap(a => a.orders);
const quoteVals = allOrders.map(o => {
  const a = o.acct; const sent = TS(o.days); const inv = o.invDays !== undefined ? TS(o.invDays) : 'null';
  return `(${q(o.id)}, ${q(a.id)}, ${q(o.number)}, ${o.amount}, ${sent}, ${o.paid === true}, ${q(o.source ?? 'cin7')}, now(), ${inv}, ${q(o.status)}, ${q(`${a.street}, ${a.suburb} ${a.state} ${a.postcode}`)}, ${chance(0.3) ? q('PO-' + ri(1000, 9999)) : 'null'}, ${q('sandbox-' + o.id.slice(0, 8))}, ${o.invNo ? q(o.invNo) : 'null'}, ${q(o.paySt ?? (o.paid ? 'PAID' : 'UNPAID'))}, ${q(o.shipping ?? 'NOT SHIPPED')}, ${q(a.contact)}, ${q(a.email)}, ${q(a.phone)}, ${q(JSON.stringify(o.ful ?? []))}::jsonb, ${o.tax}, ${o.total}, ${o.picking ? q(o.picking) : 'null'}, ${n_(o.amountPaid ?? 0)}, ${q(JSON.stringify(o.invoices ?? []))}::jsonb, ${n_(o.invoiced ?? null)}, ${n_(o.due ?? null)}, ${o.amount}, ${o.paidDays !== undefined ? TS(o.paidDays) : 'null'}, ${o.fu2On !== undefined ? D(-(-o.fu2On)) : 'null'}, ${o.fu1 !== undefined ? D(o.fu1) : 'null'}, ${o.fu2Done !== undefined ? D(o.fu2Done) : 'null'}, ${q(JSON.stringify(o.lf ?? {}))}::jsonb)`;
});
out.push(rows('quotes', 'id, account_id, number, amount, sent_at, paid, source, synced_at, invoice_date, fulfillment_status, shipping_address, reference, dear_sale_id, invoice_number, payment_status, shipping_status, order_contact, order_email, order_phone, fulfilments, tax_total, total, picking_status, amount_paid, invoices, invoiced_total, amount_due, goods_total, paid_at, follow_up_at, fu1_done_on, fu2_done_on, line_fulfilment', quoteVals, 60));
out.push(`update crm.quotes q set follow_up_rep_id = a.rep_id from crm.accounts a where a.id = q.account_id and (q.follow_up_at is not null or q.fu1_done_on is not null);`);
out.push(rows('quote_lines', 'quote_id, sku, product_name, brand, quantity, unit_price, line_total, discount, tax', allOrders.flatMap(o => o.lines.map(l => `(${q(o.id)}, ${q(l.sku)}, ${q(l.name)}, ${q(l.brand)}, ${l.qty}, ${l.unit}, ${l.total}, ${l.disc}, ${l.tax})`)), 200));
out.push(rows('purchases', 'id, number, supplier, status, receiving_status, order_date, required_by', pos.map(p => `(${q(p.id)}, ${q(p.number)}, ${q(p.supplier)}, ${q(p.status)}, ${q(p.recv)}, ${TS(p.orderDays)}, ${p.reqDays >= 0 ? TS(p.reqDays) : `((current_date + ${-p.reqDays})::timestamp)`})`)));
out.push(rows('purchase_lines', 'purchase_id, sku, product_name, quantity_ordered, quantity_received, last_received_at', pos.flatMap(po => po.lines.map(l => `(${q(po.id)}, ${q(l.p.sku)}, ${q(l.p.name)}, ${l.ord}, ${l.recv}, ${l.recv > 0 ? TS(Math.max(0, po.reqDays > 0 ? po.reqDays : 3)) : 'null'})`)), 200));
out.push(rows('purchase_receipts', 'purchase_id, sku, received_at, quantity', pos.flatMap(po => po.lines.filter(l => l.recv > 0).map(l => `(${q(po.id)}, ${q(l.p.sku)}, ${TS(Math.max(0, po.reqDays > 0 ? po.reqDays : 3))}, ${l.recv})`)), 200));
out.push(rows('purchase_costs', 'purchase_id, sku, unit_cost, line_total, currency, base_currency, currency_rate', pos.flatMap(po => po.lines.map(l => { const usd = chance(0.35); const rate = usd ? 0.66 : 1; const uc = r2(l.p.cost * (0.95 + rnd() * 0.1) * (usd ? rate : 1)); return `(${q(po.id)}, ${q(l.p.sku)}, ${uc}, ${r2(uc * l.ord)}, ${usd ? "'USD'" : "'AUD'"}, 'AUD', ${rate})`; })), 200));
out.push(rows('activity', 'id, account_id, rep_id, type, note, occurred_at, created_at, quote_id',
  activity.map(x => `(gen_random_uuid(), ${q(x.a.id)}, (select rep_id from seed_slot where slot = ${x.a.slot}), ${q(x.t)}, ${q(x.note)}, ${TSH(x.d, x.h, x.m)}, ${TSH(x.d, x.h, x.m)}, ${x.quote ? q(x.quote.id) : 'null'})`), 100));
out.push(rows('tasks', 'id, "repId", "accountId", type, scheduled_date, fixed, completed, completed_at, note, updated_at, reason',
  tasks.map(t => `(gen_random_uuid(), (select rep_id from seed_slot where slot = ${t.a.slot}), ${q(t.a.id)}, ${q(t.type)}, current_date, false, ${t.done}, ${t.done ? 'now()' : 'null'}, ${t.done ? q('Spoke to ' + t.a.contact.split(' ')[0] + '. Sending the price list.') : 'null'}, now(), ${q(t.reason)})`)));
out.push(`insert into crm.budget_months (rep_id, year, month, amount)
  select s.rep_id, y, m, (35000 + ((abs(hashtext(s.rep_id::text || y || '-' || m)) % 30000)))::float from (select distinct rep_id from seed_slot) s, generate_series(2025, 2026) y, generate_series(1, 12) m;`);
out.push(`insert into crm.sync_state (key, last_synced_at) values ('stock', now() at time zone 'utc'), ('sales', now() at time zone 'utc'), ('purchases', now() at time zone 'utc') on conflict (key) do nothing;
commit;
select 'Sandbox filled with made-up data' as result, (select count(*) from crm.accounts) as shops, (select count(*) from crm.products) as products, (select count(*) from crm.quotes) as orders, (select count(*) from crm.activity) as notes;`);
writeFileSync('sandbox-seed.sql', out.join('\n\n') + '\n');
console.log(`written: ${accounts.length} shops, ${products.length} products, ${allOrders.length} orders, ${allOrders.reduce((t, o) => t + o.lines.length, 0)} order lines, ${pos.length} purchase orders, ${activity.length} notes, ${tasks.length} tasks`);
