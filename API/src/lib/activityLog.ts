import { parseFollowUp } from './followup';

// What logging a contact does to the account, besides saving the log itself. Shared by the normal log (POST /activity), the abandoned-cart log and the
// assistant's bulk log, so all of them behave the same:
//  - Logging any contact (a call, an email, a visit) against a brand-new lead is what "approached" means. A remark (a comment or feedback) is not a contact
//    with the customer, so it does not count as approaching them.
//  - The note is read for a follow-up phrase ("follow up in 3 weeks") and the reminder is set if one is found (again, not for a remark).
// `db` is the Prisma client or a transaction.
type Db = { account: { update(args: { where: { id: string }; data: { stage?: 'approached'; nextFollowUpAt?: Date } }): Promise<unknown> } };
export type LogEffects = { stage?: 'approached'; nextFollowUpAt?: Date };

/** What the log would change on the account. Pure: nothing is written. */
export function effectsOf(account: { id: string; stage: string }, activity: { type: string; note: string; occurredAt: Date }): LogEffects {
  const updates: LogEffects = {};
  const isRemark = activity.type === 'remark';
  if (!isRemark && account.stage === 'new_lead') updates.stage = 'approached';
  const followUpDate = isRemark ? null : parseFollowUp(activity.note, activity.occurredAt);
  if (followUpDate) updates.nextFollowUpAt = followUpDate;
  return updates;
}

export async function applyLogEffects(db: Db, account: { id: string; stage: string }, activity: { type: string; note: string; occurredAt: Date }) {
  const updates = effectsOf(account, activity);
  if (Object.keys(updates).length > 0) await db.account.update({ where: { id: account.id }, data: updates });
}
