// The order the account page calls "current": the NEWEST order that is still in play.
// Voided and fully credited orders are out of play, so they are skipped. (It used to pick
// the first UNPAID order, which skipped a newer prepaid order and landed on an old voided
// one.) If every order is out of play the newest is still returned, so the card is never
// empty. Works whatever order the list arrives in.
const OUT_OF_PLAY = ['VOIDED', 'CREDITED'];

export function pickCurrentOrder<T extends { sentAt: string; fulfillmentStatus?: string | null }>(quotes: T[]): T | undefined {
  const newestFirst = [...quotes].sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  return newestFirst.find(q => !OUT_OF_PLAY.includes((q.fulfillmentStatus ?? '').toUpperCase())) ?? newestFirst[0];
}