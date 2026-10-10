import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { shipTo } from './exports';

export const miscRouter = Router();

// The full ship-to, one line each: company, contact, street lines, "suburb STATE postcode",
// country (if not Australia). For marketing orders DEAR's ship-to company is often just
// "Rhino Rhino Marketing" itself, which says nothing, so a line that is only the billing
// account's name is left out, and repeats are dropped.
function shipToLines(q: Parameters<typeof shipTo>[0] & { shippingAddress: string | null }): string[] {
  const d = (q.shippingDetails ?? {}) as Record<string, string | null>;
  const to = shipTo(q);
  const company = d.company || q.shippingCompany || '';
  const structured = [company, d.contact, d.line1, d.line2, d.city, d.postcode].some(Boolean);
  const place = [d.city, to.state, d.postcode].filter(Boolean).join(' ');
  const country = d.country && !/^australia$/i.test(d.country.trim()) ? d.country : '';
  const raw = structured
    ? [company, d.contact, d.line1, d.line2, place, country]
    : (q.shippingAddress ?? '').split(/\r?\n/);   // older orders: only the saved address text
  const account = q.account.name.trim().toLowerCase();
  const seen = new Set<string>();
  return raw.map(l => (l ?? '').trim()).filter(l => {
    const k = l.toLowerCase();
    if (!l || k === account || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Company-wide, same as Sales Data — everyone sees the same list,
// not scoped to "your own accounts."
// Marketing and warranty orders are billed to one account but sent to many people
// and stores, so each row also carries where it was sent: the full ship-to details
// (sentToLines) and the state. It uses the same helper as the Excel report, so the two always agree.
miscRouter.get('/', async (req, res) => {
  const type = req.query.type as string; // 'marketing' | 'warranty'
  if (!['marketing', 'warranty'].includes(type)) {
    return res.status(400).json({ error: 'type must be "marketing" or "warranty"' });
  }

  const quotes = await prisma.quote.findMany({
    where: { miscType: type },
    include: { account: { select: { id: true, name: true, region: true } } },
    orderBy: { sentAt: 'desc' },
    take: 1000,
  });

  const rows = quotes.map(q => {
    const to = shipTo(q);
    return {
      id: q.id,
      number: q.number,
      date: q.sentAt,
      accountId: q.account.id,
      accountName: q.account.name,
      region: q.account.region,
      sentTo: to.name,
      sentToContact: to.contact,
      sentToSuburb: to.suburb,
      sentToState: to.state,
      sentToLines: shipToLines(q),
      amount: q.amount,
      reference: q.reference,
      source: q.source,
    };
  });

  res.json({ type, count: rows.length, total: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100, rows });
});