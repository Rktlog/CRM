import * as ts from './tradeshow';
import * as x from './tradeshowExtra';
import { cleanText, STATES } from './tradeshowCore';
import { norm, pickShow, type Choice, type OrderProblem } from './aiShowOrder';

// Taking a trade show LEAD or booking an APPOINTMENT by talking to the assistant. Like show_order, it never saves on its own: the tool only builds a PREVIEW,
// which the chat shows as a card with a Save button. Pressing Save sends the settled fields to /ai/show-lead/confirm or /ai/show-appointment/confirm, which
// check everything again and then use the same code as the show page. These only ADD a lead or an appointment: nothing here edits or deletes one, and the
// assistant is never told "saved". A new customer is only made when the rep presses Save on a lead that says it is new.
type Rep = { id: string; role: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Problem = OrderProblem;

// ---------- leads ----------
export type LeadAsk = { show?: string; customer?: string; accountId?: string; newCustomer?: boolean; state?: string; contact?: string; email?: string; phone?: string; address?: string; brands?: string; notes?: string };
export type LeadProposal = { showId: string; showName: string; accountId: string | null; customer: string; region: string | null; isNew: boolean; address: string | null;
  contact: { name: string | null; email: string | null; phone: string | null }; brands: string | null; notes: string | null; similar: { id: string; label: string }[]; problems: Problem[] };

export async function previewLead(rep: Rep, ask: LeadAsk, today: string): Promise<LeadProposal | { problems: Problem[] }> {
  const problems: Problem[] = [];
  const shows = await ts.listShows();
  const sh = pickShow(shows as any, ask.show, today);
  if (sh.problem) problems.push(sh.problem);

  let acct: { id: string; name: string; region: string | null } | null = null;
  if (ask.accountId && UUID.test(ask.accountId)) {
    const hit = await ts.customerById(ask.accountId);
    if (hit) acct = { id: hit.id, name: hit.name, region: hit.region };
  }
  const name = cleanText(ask.customer, 120);
  let similar: ts.CustomerHit[] = [];
  let isNew = false, region: string | null = null;
  if (!acct) {
    if (!name) problems.push({ what: 'Which business?', reason: 'Say the business name for this lead.' });
    else {
      const found = await ts.searchCustomers(name);
      const exact = found.filter(c => norm(c.name) === norm(name));
      if (exact.length === 1) acct = { id: exact[0]!.id, name: exact[0]!.name, region: exact[0]!.region };
      else if (ask.newCustomer === true) {
        const st = String(ask.state ?? '').toUpperCase().trim();
        if (!STATES.includes(st)) problems.push({ what: name, reason: 'To add a new customer I need the state (NSW, VIC, QLD, WA, SA, TAS, NT, ACT or NZ).' });
        else {
          similar = await ts.lookAlikes({ name, email: cleanText(ask.email, 160), phone: cleanText(ask.phone, 40) }).catch(() => []);
          isNew = true; region = st;
        }
      } else {
        problems.push(found.length
          ? { what: name, reason: exact.length > 1 ? 'More than one customer has exactly this name. Which one?' : 'No exact match. Is it one of these, or a new customer (then say the state)?', choices: found.slice(0, 6).map(c => ({ id: c.id, label: `${c.name} (${c.region})` })) }
          : { what: name, reason: 'Radar does not have this business. Is it a new customer? If so, say the state.' });
      }
    }
  }
  if (!sh.show || (!acct && !isNew)) return { problems };
  return { showId: sh.show.id, showName: sh.show.name, accountId: acct?.id ?? null, customer: acct?.name ?? name!, region: acct?.region ?? region, isNew, address: cleanText(ask.address, 300),
    contact: { name: cleanText(ask.contact, 120), email: cleanText(ask.email, 160), phone: cleanText(ask.phone, 40) }, brands: cleanText(ask.brands, 300), notes: cleanText(ask.notes, 2000),
    similar: similar.map(s => ({ id: s.id, label: `${s.name} (${s.region})` })), problems };
}

/** Pressing Save lead: everything is checked again, then it is the same code as the New lead button on the show page. */
export async function saveLead(rep: Rep, b: any): Promise<{ leadId: string; customer: string; isNew: boolean }> {
  const showId = String(b?.showId ?? '');
  if (!UUID.test(showId)) throw new ts.TsError('Something was missing. Ask the assistant to prepare the lead again.');
  const contact = { contactName: cleanText(b?.contact?.name, 120), contactEmail: cleanText(b?.contact?.email, 160), contactPhone: cleanText(b?.contact?.phone, 40), brands: cleanText(b?.brands, 300), notes: cleanText(b?.notes, 2000) };
  if (b?.accountId) {
    const accountId = String(b.accountId);
    if (!UUID.test(accountId)) throw new ts.TsError('That customer was not valid. Ask the assistant to prepare the lead again.');
    const leadId = await ts.createLead(rep, { showId, accountId, ...contact });
    return { leadId, customer: (await ts.customerById(accountId))?.name ?? 'the customer', isNew: false };
  }
  const nc = { name: cleanText(b?.customer, 120), region: String(b?.region ?? '').toUpperCase(), contact: contact.contactName, email: contact.contactEmail, phone: contact.contactPhone, address: cleanText(b?.address, 300) };
  if (!nc.name) throw new ts.TsError('Something was missing. Ask the assistant to prepare the lead again.');
  // a look-alike account stops it (409) unless the rep ticked "this is a different, new customer"
  const leadId = await ts.createLead(rep, { showId, newCustomer: { ...nc, confirmNew: b?.confirmNew === true }, ...contact });
  return { leadId, customer: nc.name, isNew: true };
}

export function leadSummary(p: LeadProposal | { problems: Problem[] }) {
  if (!('showId' in p)) return { previewShownToPerson: false, savedNothing: true, problems: p.problems, note: 'Nothing is ready yet. Ask the person for what is missing or which one they mean (use the choices), then call show_lead again with everything.' };
  return { previewShownToPerson: true, savedNothingYet: true, show: p.showName, customer: p.customer, newCustomer: p.isNew, similarAccounts: p.similar.map(s => s.label), problems: p.problems,
    note: 'A card with a Save lead button is shown in the chat. NOTHING is saved until the person presses it. A new customer is only made when they press Save. Never say the lead is saved, taken or added.' };
}

// ---------- appointments ----------
export type AppointmentAsk = { show?: string; stockist?: string; accountId?: string; contact?: string; state?: string; day?: string; time?: string; who?: string; comments?: string; targetRange?: string };
export type AppointmentProposal = { showId: string; showName: string; stockist: string; accountId: string | null; linkedTo: string | null; contact: string | null; state: string | null; day: string | null; time: string | null;
  who: string | null; comments: string | null; targetRange: string | null; warnings: string[]; problems: Problem[] };

export async function previewAppointment(_rep: Rep, ask: AppointmentAsk, today: string): Promise<AppointmentProposal | { problems: Problem[] }> {
  const problems: Problem[] = [], warnings: string[] = [];
  const shows = await ts.listShows();
  const sh = pickShow(shows as any, ask.show, today);
  if (sh.problem) problems.push(sh.problem);
  const stockist = cleanText(ask.stockist, 120);
  if (!stockist) problems.push({ what: 'Which stockist?', reason: 'Say who the appointment is with.' });
  const state = cleanText(ask.state, 20);
  if (state && !STATES.includes(state.toUpperCase())) warnings.push(`"${state}" is not a state Radar knows. It will be saved as typed.`);

  // linked to an existing customer only when the name matches exactly (the same rule the Appointments tab uses when it saves)
  let accountId: string | null = null, linkedTo: string | null = null;
  if (ask.accountId && UUID.test(ask.accountId)) { const hit = await ts.customerById(ask.accountId); if (hit) { accountId = hit.id; linkedTo = hit.name; } }
  else if (stockist) {
    const found = await ts.searchCustomers(stockist).catch(() => []);
    const exact = found.filter(c => norm(c.name) === norm(stockist));
    if (exact.length === 1) { accountId = exact[0]!.id; linkedTo = exact[0]!.name; }
    else if (exact.length > 1) problems.push({ what: stockist, reason: 'More than one customer has exactly this name. Which one?', choices: exact.slice(0, 6).map((c): Choice => ({ id: c.id, label: `${c.name} (${c.region})` })) });
    else warnings.push('Not linked to a customer in Radar (no exact name match). It is still saved on the Appointments tab.');
  }
  if (sh.show && stockist) {
    const have = await x.listAppointments(sh.show.id).catch(() => []);
    const dup = have.filter(a => norm(a.stockist) === norm(stockist) && a.status !== 'cancelled');
    if (dup.length) warnings.push(`There is already an appointment with ${dup[0]!.stockist} at this show${dup[0]!.dayText || dup[0]!.timeText ? ` (${[dup[0]!.dayText, dup[0]!.timeText].filter(Boolean).join(' ')})` : ''}. Saving adds another.`);
  }
  if (!sh.show || !stockist || problems.length) return { problems };
  return { showId: sh.show.id, showName: sh.show.name, stockist, accountId, linkedTo, contact: cleanText(ask.contact, 120), state, day: cleanText(ask.day, 60), time: cleanText(ask.time, 60), who: cleanText(ask.who, 40),
    comments: cleanText(ask.comments, 1000), targetRange: cleanText(ask.targetRange, 1000), warnings, problems };
}

/** Pressing Save appointment: the same code as the Appointments tab, adding one new row. */
export async function saveAppointment(rep: Rep, b: any): Promise<{ appointmentId: string }> {
  const showId = String(b?.showId ?? '');
  if (!UUID.test(showId)) throw new ts.TsError('Something was missing. Ask the assistant to prepare the appointment again.');
  const id = await x.saveAppointment(rep, showId, {
    stockist: b?.stockist, accountId: b?.accountId && UUID.test(String(b.accountId)) ? b.accountId : null, contact: b?.contact, state: b?.state, dayText: b?.day, timeText: b?.time, who: b?.who,
    comments: b?.comments, targetRange: b?.targetRange, status: 'booked',
  });
  return { appointmentId: id };
}

export function appointmentSummary(p: AppointmentProposal | { problems: Problem[] }) {
  if (!('showId' in p)) return { previewShownToPerson: false, savedNothing: true, problems: p.problems, note: 'Nothing is ready yet. Ask the person for what is missing or which one they mean (use the choices), then call show_appointment again with everything.' };
  return { previewShownToPerson: true, savedNothingYet: true, show: p.showName, stockist: p.stockist, linkedTo: p.linkedTo, day: p.day, time: p.time, warnings: p.warnings,
    note: 'A card with a Save appointment button is shown in the chat. NOTHING is saved until the person presses it. It is added to the show\'s Appointments tab (not Google Calendar). Never say it is booked or saved.' };
}
