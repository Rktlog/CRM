import { Router } from 'express';
import { ACTIVITY_TARGETS, activitySummary, addDays, addMonths, mondayOf, monthStart, regionsOf } from '../lib/weeklyActivity';
import { melDay } from '../lib/receivables';

// The weekly activity shown just under a rep's Summary sheet on the Dashboard.
// A rep only ever gets their own figures. A manager asks for one rep at a time, with &repId= (the folded rep summaries on the Dashboard).
//   GET /rep-summary/activity?weeks=12             the last 4 to 52 weeks, and this month and the two before
//   GET /rep-summary/activity?weeks=12&repId=...   managers only: that rep's
export const repSummaryRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

repSummaryRouter.get('/activity', async (req, res) => {
  try {
    const me = req.rep!;
    let repId = me.id;
    if (me.role === 'manager') {
      const asked = String(req.query.repId ?? '');
      if (!UUID.test(asked)) return res.status(400).json({ error: 'Pick a rep' });
      repId = asked;
    }   // anyone else only ever gets their own
    const weeks = Math.min(52, Math.max(4, Math.floor(Number(req.query.weeks)) || 12));
    const today = melDay();
    const regions = await regionsOf(repId);
    const [weekRows, monthRows] = await Promise.all([
      activitySummary({ repId, regions, from: mondayOf(addDays(today, -7 * (weeks - 1))), to: today, grain: 'week' }),
      activitySummary({ repId, regions, from: addMonths(monthStart(today), -2), to: today, grain: 'month' }),
    ]);
    res.json({ targets: ACTIVITY_TARGETS, today, regions, weeks: weekRows, months: monthRows });
  } catch (e) {
    console.error('rep summary failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not load the weekly activity' });
  }
});