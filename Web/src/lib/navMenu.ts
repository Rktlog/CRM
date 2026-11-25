// The navigation: a Dashboard link, then six dropdown tabs, each holding its pages. Ordering and Marketing are for managers only, as before; a tab with nothing
// left in it for the person (Marketing, for a rep) is not shown at all.
// marketing: the pages a marketing login sees. It sees nothing else (not even the Dashboard), and is sent to the Marketing Dashboard instead.
export type NavItem = { to: string; label: string; managerOnly?: boolean; marketing?: boolean };
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
      { to: '/products', label: 'Products', marketing: true },
      { to: '/catalogue', label: 'Catalogue', marketing: true },
      { to: '/product-requests', label: 'Product Requests' },
      { to: '/liewood', label: 'Liewood' },
      { to: '/trade-shows', label: 'Trade Shows', marketing: true },
      { to: '/ordering', label: 'Order Forecast & Procurement', managerOnly: true },   // the page that was called Ordering
    ],
  },
  {
    key: 'marketing',
    label: 'Marketing & Sales Support',
    items: [{ to: '/marketing', label: 'Email Builder', managerOnly: true, marketing: true }, { to: '/marketing-dashboard', label: 'Marketing Dashboard', managerOnly: true, marketing: true }],   // every page under /marketing counts as this one
  },
  {
    key: 'insights',
    label: 'Insights & Reporting',
    items: [
      { to: '/sales-data', label: 'Sales Data' },
      { to: '/reports', label: 'Reports' },
      { to: '/ellen', label: 'Ellen', managerOnly: true },
    ],
    also: ['/conversion'],
  },
  {
    key: 'tools',
    label: 'Tools & Administration',
    items: [
      { to: '/assistant', label: 'Assistant', marketing: true },
      { to: '/promos', label: 'Promos' },
      { to: '/sales-tools', label: 'Sales Tools' },
      { to: '/misc', label: 'Misc', marketing: true },
      { to: '/settings', label: 'Settings', marketing: true },
    ],
  },
];

/** The tabs a person sees: manager-only pages only for managers, a marketing login only its own pages, and no tab that ends up empty. */
export function visibleGroups(role: string | null | undefined): NavGroup[] {
  return NAV_GROUPS
    .map(g => ({ ...g, items: g.items.filter(i => role === 'marketing' ? !!i.marketing : !i.managerOnly || role === 'manager') }))
    .filter(g => g.items.length > 0);
}

/** Where a marketing login lands instead of the Dashboard (which is built around a rep's territory and would be empty for it). */
export const MARKETING_HOME = '/marketing-dashboard';

/** Whether a marketing login may open this page: its own menu pages, and the pages under them (a product, a trade show, a campaign). */
export function marketingMay(pathname: string): boolean {
  return NAV_GROUPS.some(g => g.items.some(i => i.marketing && within(i.to, pathname)));
}

function within(prefix: string, pathname: string) { return pathname === prefix || pathname.startsWith(prefix + '/'); }

/** Which tab a page belongs to (so its tab can be highlighted), or null for the Dashboard and anything unknown. Looks at every tab, not only the visible ones. */
export function groupKeyForPath(pathname: string): string | null {
  for (const g of NAV_GROUPS) {
    if ([...g.items.map(i => i.to), ...(g.also ?? [])].some(p => within(p, pathname))) return g.key;
  }
  return null;
}