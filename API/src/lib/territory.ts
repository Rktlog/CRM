import { prisma } from './prisma';

// One rule for which accounts a person can see, used by Accounts,
// Pipeline, account detail, activity, exports, abandoned carts and
// Sales Data:
//   - managers: every account
//   - reps: accounts in their assigned states only (Settings → Assign
//     reps to states). No states assigned means nothing shows.
// Enforced in the API, so a rep can't reach another territory by URL.

type RepRef = { id: string; role: string };

export async function assignedRegions(repId: string): Promise<string[]> {
  return (await prisma.repRegion.findMany({ where: { repId }, select: { region: true } })).map(r => r.region);
}

// Prisma `where` fragment for accounts this person can see. Reps see
// their assigned states only; no states assigned means nothing.
export async function territoryWhere(rep: RepRef): Promise<any> {
  if (rep.role === 'manager') return {};
  const regions = await assignedRegions(rep.id);
  return regions.length ? { region: { in: regions } } : { id: { in: [] } };
}

export async function canSeeAccount(rep: RepRef, account: { region: string }): Promise<boolean> {
  if (rep.role === 'manager') return true;
  return (await assignedRegions(rep.id)).includes(account.region);
}