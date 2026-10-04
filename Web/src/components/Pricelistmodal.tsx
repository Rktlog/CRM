import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiDownload } from '../lib/api';

// Choose what goes in a store's price list before downloading it: which
// brands, which products (current range / new / the rest), and which
// availability. Defaults to the brands the store already stocks, all rows.

type BrandOption = { brand: string; products: number; bought: boolean };

const STATUSES = [
  { key: 'current', label: 'Current Range', hint: 'Products they already stock' },
  { key: 'new', label: 'New', hint: 'Arrived in the last 90 days' },
  { key: 'other', label: 'Rest of the range', hint: 'Everything else in those brands' },
] as const;

const AVAILABILITY = [
  { key: 'available', label: 'Available' },
  { key: 'preorder', label: 'Preorder' },
  { key: 'discontinued', label: 'Discontinued', hint: 'Only shows on their current range' },
] as const;

export default function PriceListModal({ accountId, accountName, onClose }: {
  accountId: string; accountName: string; onClose: () => void;
}) {
  const [brands, setBrands] = useState<BrandOption[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set(STATUSES.map(s => s.key)));
  const [availability, setAvailability] = useState<Set<string>>(new Set(AVAILABILITY.map(a => a.key)));
  const [showAllBrands, setShowAllBrands] = useState(false);
  const [brandSearch, setBrandSearch] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet(`/accounts/${accountId}/pricelist-options`)
      .then((o: { brands: BrandOption[] }) => {
        setBrands(o.brands);
        setSelected(new Set(o.brands.filter(b => b.bought).map(b => b.brand)));
        if (!o.brands.some(b => b.bought)) setShowAllBrands(true); // nothing bought yet: show the full list
      })
      .catch(e => setError(e.message));
  }, [accountId]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    setter(next);
  };

  const visibleBrands = useMemo(() => {
    const q = brandSearch.trim().toLowerCase();
    return (brands ?? [])
      .filter(b => showAllBrands || b.bought || selected.has(b.brand))
      .filter(b => !q || b.brand.toLowerCase().includes(q));
  }, [brands, showAllBrands, brandSearch, selected]);

  const productCount = (brands ?? []).filter(b => selected.has(b.brand)).reduce((s, b) => s + b.products, 0);
  const canDownload = selected.size > 0 && statuses.size > 0 && availability.size > 0;

  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        accountId,
        brands: [...selected].join('|'),
        status: [...statuses].join(','),
        availability: [...availability].join(','),
      });
      const file = `${accountName.replace(/[^a-z0-9]+/gi, ' ').trim()}.xlsx`;
      await apiDownload(`/exports/account-pricelist?${params.toString()}`, file);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card pricelist-card" onClick={e => e.stopPropagation()}>
        <h3 style={{ marginBottom: 4 }}>Price list for {accountName}</h3>
        <div className="acct-region" style={{ marginBottom: 14 }}>
          Choose what to include, then download. Prices, stock and dates are as of the latest sync.
        </div>

        <div className="pl-section">
          <div className="pl-title">
            Brands <span className="acct-region">{selected.size} selected{productCount ? `, about ${productCount} products` : ''}</span>
          </div>
          {!brands ? (
            <div className="acct-region">Loading brands…</div>
          ) : (
            <>
              <div className="pl-brand-tools">
                <input value={brandSearch} onChange={e => setBrandSearch(e.target.value)} placeholder="Search brands" />
                <button type="button" className="link-btn" onClick={() => setShowAllBrands(!showAllBrands)}>
                  {showAllBrands ? 'Show only brands they stock' : `Show all ${brands.length} brands`}
                </button>
                <button type="button" className="link-btn" onClick={() => setSelected(new Set(visibleBrands.map(b => b.brand)))}>Select shown</button>
                <button type="button" className="link-btn" onClick={() => setSelected(new Set())}>Clear</button>
              </div>
              <div className="pl-brands">
                {visibleBrands.map(b => (
                  <label key={b.brand} className="pl-check">
                    <input type="checkbox" checked={selected.has(b.brand)} onChange={() => toggle(selected, setSelected, b.brand)} />
                    <span>{b.brand}</span>
                    <span className="acct-region">{b.products}{b.bought ? ', stocks it' : ''}</span>
                  </label>
                ))}
                {visibleBrands.length === 0 && <div className="acct-region">No brands match.</div>}
              </div>
            </>
          )}
        </div>

        <div className="pl-row">
          <div className="pl-section">
            <div className="pl-title">Products</div>
            {STATUSES.map(s => (
              <label key={s.key} className="pl-check">
                <input type="checkbox" checked={statuses.has(s.key)} onChange={() => toggle(statuses, setStatuses, s.key)} />
                <span>{s.label}</span>
                <span className="acct-region">{s.hint}</span>
              </label>
            ))}
          </div>
          <div className="pl-section">
            <div className="pl-title">Availability</div>
            {AVAILABILITY.map(a => (
              <label key={a.key} className="pl-check">
                <input type="checkbox" checked={availability.has(a.key)} onChange={() => toggle(availability, setAvailability, a.key)} />
                <span>{a.label}</span>
                {'hint' in a && <span className="acct-region">{a.hint}</span>}
              </label>
            ))}
          </div>
        </div>

        {error && <div className="login-error" style={{ marginBottom: 10 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={download} disabled={downloading || !canDownload}>
            {downloading ? 'Building…' : '⬇ Download price list'}
          </button>
        </div>
      </div>
    </div>
  );
}