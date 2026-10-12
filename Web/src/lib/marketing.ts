// Types and small helpers for the Marketing section.
export type Block =
  | { id: string; type: 'heading'; text: string; align?: 'left' | 'center' }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'image'; url: string; alt?: string; link?: string }
  | { id: string; type: 'button'; label: string; url: string }
  | { id: string; type: 'products'; skus: string[]; showPrice?: boolean; columns?: 2 | 3; link?: string }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; size?: number }
  | { id: string; type: 'items' }
  | { id: string; type: 'details' };
export type BlockType = Block['type'];

export const BLOCK_NAMES: Record<BlockType, string> = {
  heading: 'Heading', text: 'Text', image: 'Picture', button: 'Button', products: 'Products', divider: 'Line', spacer: 'Space',
  items: 'Cart or order items', details: 'Order details',
};
// The two that only make sense in an automatic email, where there is an order or a cart to show.
export const AUTOMATION_ONLY: BlockType[] = ['items', 'details'];

let counter = 0;
export function newBlock(type: BlockType): Block {
  const id = `n${Date.now().toString(36)}${++counter}`;
  switch (type) {
    case 'heading': return { id, type, text: 'Heading', align: 'left' };
    case 'text': return { id, type, text: '' };
    case 'image': return { id, type, url: '', alt: '', link: '' };
    case 'button': return { id, type, label: 'Order now', url: '{{portal_link}}' };
    case 'products': return { id, type, skus: [], showPrice: false, columns: 2, link: '{{portal_link}}' };
    case 'spacer': return { id, type, size: 20 };
    default: return { id, type } as Block;
  }
}

export type MergeTag = { tag: string; label: string; sample: string; group: string };
export const money = (n: number | null | undefined) => (n == null ? '' : '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const pct = (n: number | null | undefined) => `${Math.round((n ?? 0) * 10) / 10}%`;
export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString('en-AU');

export const CONTACT_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  subscribed: { label: 'Subscribed', tone: 'ok' },
  pending: { label: 'Needs consent check', tone: 'warn' },
  unsubscribed: { label: 'Unsubscribed', tone: 'muted' },
  bounced: { label: 'Bounced', tone: 'bad' },
  complained: { label: 'Marked as spam', tone: 'bad' },
};
export const CAMPAIGN_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  draft: { label: 'Draft', tone: 'muted' }, scheduled: { label: 'Scheduled', tone: 'warn' }, sending: { label: 'Sending', tone: 'warn' }, sent: { label: 'Sent', tone: 'ok' }, cancelled: { label: 'Cancelled', tone: 'bad' },
};
export const MESSAGE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  queued: { label: 'Waiting', tone: 'warn' }, sending: { label: 'Sending', tone: 'warn' }, sent: { label: 'Sent', tone: 'ok' }, failed: { label: 'Failed', tone: 'bad' },
  skipped: { label: 'Skipped', tone: 'muted' }, bounced: { label: 'Bounced', tone: 'bad' }, complained: { label: 'Spam', tone: 'bad' },
};
export const CONTACT_TYPES: { value: string; label: string }[] = [{ value: 'customer', label: 'Customers' }, { value: 'inactive', label: 'Inactive customers' }, { value: 'prospect', label: 'Leads' }];
export const SOURCES: { value: string; label: string }[] = [{ value: 'crm_customer', label: 'CRM customers' }, { value: 'crm_lead', label: 'CRM leads' }, { value: 'import', label: 'Imported' }, { value: 'manual', label: 'Added by hand' }];

export type AudienceFilter = { tags?: string[]; excludeTags?: string[]; regions?: string[]; types?: string[]; sources?: string[] };
export const filterIsEmpty = (f: AudienceFilter | undefined) => !f || !Object.values(f).some(v => Array.isArray(v) && v.length);
export function describeFilter(f: AudienceFilter | undefined): string {
  if (filterIsEmpty(f)) return 'Everyone who is subscribed';
  const parts: string[] = [];
  if (f!.tags?.length) parts.push(`tagged ${f!.tags.join(' or ')}`);
  if (f!.excludeTags?.length) parts.push(`not tagged ${f!.excludeTags.join(' or ')}`);
  if (f!.regions?.length) parts.push(`in ${f!.regions.join(', ')}`);
  if (f!.types?.length) parts.push(f!.types.map(t => CONTACT_TYPES.find(x => x.value === t)?.label.toLowerCase() ?? t).join(' or '));
  if (f!.sources?.length) parts.push(`from ${f!.sources.map(s => SOURCES.find(x => x.value === s)?.label.toLowerCase() ?? s).join(' or ')}`);
  return `Subscribed contacts ${parts.join(', ')}`;
}