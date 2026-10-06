import { prisma } from './prisma';

// One rule for which accounts a person can see, used by Accounts,
// Pipeline, Customers, Planner, Orders, account detail, activity, exports,
// abandoned carts and Sales Data:
//   - managers: every account
//   - reps: accounts in their assigned states (Settings → Assign reps to
//     states), minus any accounts a manager has hidden from them
//     (Settings → hidden accounts). No states assigned means nothing shows.
// Enforced in the API, so a rep can't reach another territory by URL.

type RepRef = { id: string; role: string };

export async function assignedRegions(repId: string): Promise<string[]> {
  return (await prisma.repRegion.findMany({ where: { repId }, select: { region: true } })).map(r => r.region);
}

// Accounts a manager has hidden from this rep, even within their states.
export async function hiddenAccountIds(repId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ account_id: string }[]>`
    select account_id from crm.rep_account_exclusions where rep_id = ${repId}::uuid`;
  return rows.map(r => r.account_id);
}

// Prisma `where` fragment for accounts this person can see.
export async function territoryWhere(rep: RepRef): Promise<any> {
  if (rep.role === 'manager') return {};
  const [regions, hidden] = await Promise.all([assignedRegions(rep.id), hiddenAccountIds(rep.id)]);
  if (!regions.length) return { id: { in: [] } };
  return hidden.length ? { region: { in: regions }, id: { notIn: hidden } } : { region: { in: regions } };
}

export async function canSeeAccount(rep: RepRef, account: { id?: string; region: string }): Promise<boolean> {
  if (rep.role === 'manager') return true;
  if (!(await assignedRegions(rep.id)).includes(account.region)) return false;
  return !account.id || !(await hiddenAccountIds(rep.id)).includes(account.id);
}