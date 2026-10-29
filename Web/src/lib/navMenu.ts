// The navigation: a Dashboard link, then six dropdown tabs, each holding its pages. Ordering and Marketing are for managers only, as before; a tab with nothing
// left in it for the person (Marketing, for a rep) is not shown at all.
export type NavItem = { to: string; label: string; managerOnly?: boolean };
export type NavGroup = {
  key: string;
  label: string;
  items: NavItem[];
  // Pages that belong to this tab but have no menu entry of their own (the detail page of something in the menu, say). They only light up the tab.
  also?: string[];
};

export const HOME: NavItem = { to: '/', label: 'Dashboard' };

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'sales',
    label: 'Sales & Customers',
    items: [
      { to: '/planner', label: 'Planner' },
      { to: '/pipeline', label: 'Pipeline' },
      { to: '/customers', label: 'Customers' },
      { to: '/accounts', label: 'Accounts' },
      { to: '/activity', label: 'Activity Log' },
      { to: '/abandoned-carts', label: 'Abandoned Carts' },
    ],
    also: ['/inactive-stockists', '/council', '/visits'],
  },
  {
    key: 'orders',
    label: 'Orders & Finance',
    items: [
      { to: '/orders', label: 'Orders' },
      { to: '/credit', label: 'Credit' },
    ],
  },
  {
    key: 'products',
    label: 'Products & Catalogue',
    items: [
      { to: '/products', label: 'Products' },
      { to: '/catalogue', label: 'Catalogue' },
      { to: '/ordering', label: 'Order Forecast & Procurement', managerOnly: true },   // the page that was called Ordering
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing & Sales Support',
    items: [{ to: '/marketing', label: 'Marketing', managerOnly: true }],   // every page under /marketing counts as this one
  },
  {
    key: 'insights',
    label: 'Insights & Reporting',
    items: [
      { to: '/sales-data', label: 'Sales Data' },
      { to: '/reports', label: 'Reports' },
    ],
    also: ['/conversion'],
  },
  {
    key: 'tools',
    label: 'Tools & Administration',
    items: [
      { to: '/assistant', label: 'Assistant' },
      { to: '/misc', label: 'Misc' },
      { to: '/settings', label: 'Settings' },
    ],
  },
];

/** The tabs a person sees: manager-only pages only for managers, and no tab that ends up empty. */
export function visibleGroups(role: string | null | undefined): NavGroup[] {
  return NAV_GROUPS
    .map(g => ({ ...g, items: g.items.filter(i => !i.managerOnly || role === 'manager') }))
    .filter(g => g.items.length > 0);
}

const within = (prefix: string, pathname: string) => pathname === prefix || pathname.startsWith(prefix + '/');

/** Which tab a page belongs to (so its tab can be highlighted), or null for the Dashboard and anything unknown. Looks at every tab, not only the visible ones. */
export function groupKeyForPath(pathname: string): string | null {
  for (const g of NAV_GROUPS) {
    if ([...g.items.map(i => i.to), ...(g.also ?? [])].some(p => within(p, pathname))) return g.key;
  }
  return null;
}