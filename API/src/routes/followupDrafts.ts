import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { cleanAddress, draftLink } from '../lib/gmail/google';
import { GRACE_DAYS, loadSettings, mailboxProblem, reminderMessage, runFollowUpDrafts } from '../lib/followupDrafts';

// Settings for the payment reminder drafts (managers). The drafts themselves are made by the scheduled job (see lib/followupDrafts.ts).
//   GET   /followup-drafts/settings   the switch, the mailbox and whether it is ready, the email as it will read, and the latest drafts
//   PATCH /followup-drafts/settings   { enabled?: boolean, mailbox?: email }
//   POST  /followup-drafts/preview    who would get a draft today, without making any
//   POST  /followup-drafts/run        make today's drafts now (only when switched on)
export const followUpDraftsRouter = Router();
const managersOnly = (req: any, res: any) => { if (req.rep!.role !== 'manager') { res.status(403).json({ error: 'Only a manager can change payment reminder drafts' }); return false; } return true; };
const failed = (res: any, e: unknown) => res.status(500).json({ error: String((e as Error)?.message ?? e).slice(0, 200) });

followUpDraftsRouter.get('/settings', async (req, res) => {
  if (!managersOnly(req, res)) return;
  try {
    const s = await loadSettings(), { problem } = await mailboxProblem(s.mailbox);
    const recent = await prisma.$queryRaw<{ id: string; quote_number: string; customer: string; to_addr: string | null; status: string; error: string | null; mailbox: string | null; gmail_message_id: string | null; created_at: Date }[]>`
      select id, quote_number, customer, to_addr, status, error, mailbox, gmail_message_id, created_at from crm.followup_drafts order by created_at desc limit 20`;
    const [n] = await prisma.$queryRaw<{ made: number; failed: number }[]>`
      select count(*) filter (where status = 'created' and created_at > now() - interval '7 days')::int as made, count(*) filter (where status = 'failed')::int as failed from crm.followup_drafts`;
    res.json({
      enabled: s.enabled, mailbox: s.mailbox, ready: !problem, problem, graceDays: GRACE_DAYS, sample: reminderMessage('Pat', 'SQ12345'),
      madeLast7Days: n?.made ?? 0, failedNow: n?.failed ?? 0,
      recent: recent.map(r => ({ id: r.id, number: r.quote_number, customer: r.customer, to: r.to_addr, status: r.status, error: r.error, createdAt: r.created_at, link: r.status === 'created' && r.gmail_message_id && r.mailbox ? draftLink(r.mailbox, r.gmail_message_id) : null })),
    });
  } catch (e) { failed(res, e); }
});

followUpDraftsRouter.patch('/settings', async (req, res) => {
  if (!managersOnly(req, res)) return;
  const b = req.body ?? {};
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'Say whether it is on or off' });
  const mailbox = b.mailbox === undefined ? undefined : cleanAddress(b.mailbox)?.toLowerCase();
  if (b.mailbox !== undefined && !mailbox) return res.status(400).json({ error: 'That is not an email address' });
  if (b.enabled === undefined && mailbox === undefined) return res.status(400).json({ error: 'Nothing to change' });
  try {
    if (typeof b.enabled === 'boolean') await prisma.$executeRaw`update crm.followup_draft_settings set enabled = ${b.enabled}, updated_at = now(), updated_by = ${req.rep!.id}::uuid where id = 1`;
    if (mailbox) await prisma.$executeRaw`update crm.followup_draft_settings set mailbox_email = ${mailbox}, updated_at = now(), updated_by = ${req.rep!.id}::uuid where id = 1`;
    res.json({ ok: true, ...(await loadSettings()) });
  } catch (e) { failed(res, e); }
});

followUpDraftsRouter.post('/preview', async (req, res) => {
  if (!managersOnly(req, res)) return;
  try { res.json(await runFollowUpDrafts({ dryRun: true })); } catch (e) { failed(res, e); }
});

followUpDraftsRouter.post('/run', async (req, res) => {
  if (!managersOnly(req, res)) return;
  try {
    if (!(await loadSettings()).enabled) return res.status(409).json({ error: 'Switch payment reminder drafts on first' });
    res.json(await runFollowUpDrafts());
  } catch (e) { failed(res, e); }
});