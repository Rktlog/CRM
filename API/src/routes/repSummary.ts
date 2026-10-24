import { Router } from 'express';
import { ACTIVITY_TARGETS, activitySummary, addDays, addMonths, mondayOf, monthStart, regionsOf } from '../lib/weeklyActivity';
import { melDay } from '../lib/receivables';

// The rep's own summary on Sales Data. Only the signed-in person's own figures are ever returned (managers do not have this block;
// they download the same figures for every rep from Reports > Weekly activity).
//   GET /rep-summary/activity?weeks=12   the last 4 to 52 weeks, and this month and the two before
export const repSummaryRouter = Router();

repSummaryRouter.get('/activity', async (req, res) => {
  try {
    const rep = req.rep!;
    const weeks = Math.min(52, Math.max(4, Math.floor(Number(req.query.weeks)) || 12));
    const today = melDay();
    const regions = await regionsOf(rep.id);
    const [weekRows, monthRows] = await Promise.all([
      activitySummary({ repId: rep.id, regions, from: mondayOf(addDays(today, -7 * (weeks - 1))), to: today, grain: 'week' }),
      activitySummary({ repId: rep.id, regions, from: addMonths(monthStart(today), -2), to: today, grain: 'month' }),
    ]);
    res.json({ targets: ACTIVITY_TARGETS, today, regions, weeks: weekRows, months: monthRows });
  } catch (e) {
    console.error('rep summary failed:', (e as Error).message);
    res.status(500).json({ error: 'Could not load your summary' });
  }
});