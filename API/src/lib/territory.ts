import { prisma } from './prisma';

// One rule for which accounts a person can see, used by Accounts,
// Pipeline, account detail, activity and exports:
//   - managers: every account
//   - reps: accounts in their assigned states (Settings → Assign reps
//     to states), plus any account they personally own elsewhere
//   - reps with no states assigned yet: only their own accounts
// Enforced in the API, so a rep can't reach another territory by URL.

type RepRef = { id: string; role: string };

export async function assignedRegions(repId: string): Promise<string[]> {
  return (await prisma.repRegion.findMany({ where: { repId }, select: { region: true } })).map(r => r.region);
}

// Prisma `where` fragment for accounts this person can see.
export async function territoryWhere(rep: RepRef): Promise<any> {
  if (rep.role === 'manager') return {};
  const regions = await assignedRegions(rep.id);
  if (!regions.length) return { repId: rep.id };
  return { OR: [{ region: { in: regions } }, { repId: rep.id }] };
}

export async function canSeeAccount(rep: RepRef, account: { repId: string; region: string }): Promise<boolean> {
  if (rep.role === 'manager' || account.repId === rep.id) return true;
  return (await assignedRegions(rep.id)).includes(account.region);
}