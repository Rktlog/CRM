// Product statuses, as shown on the Products page and the catalogue.
export const PRODUCT_STATUSES = [
  { key: 'eol', label: 'EOL', tone: 'rust', meaning: 'End of line' },
  { key: 'discontinued', label: 'Discontinued', tone: 'neutral', meaning: 'No longer available' },
  { key: 'preorder', label: 'Pre-order', tone: 'amber', meaning: 'Not in stock yet, taking orders' },
  { key: 'new', label: 'New', tone: 'teal', meaning: 'New to the range' },
  { key: 'ranging', label: 'Confirmed for Ranging', tone: 'teal', meaning: 'Confirmed to be ranged' },
  { key: 'customer_only', label: 'For Customer Only Then Cease', tone: 'amber', meaning: 'Only for customer orders, then the product ceases' },
  { key: 'preorder_only', label: 'Preorder Only', tone: 'amber', meaning: 'Only available to pre-order' },
] as const;
export type ProductStatusKey = (typeof PRODUCT_STATUSES)[number]['key'];
export const statusInfo = (key: string | null | undefined) => PRODUCT_STATUSES.find(s => s.key === key) ?? null;