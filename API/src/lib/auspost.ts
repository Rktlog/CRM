// Australia Post's Postage Assessment Calculator (PAC): what a parcel costs to send, domestic or international.
// It needs only an API key (the free one from developers.auspost.com.au), sent as the AUTH-KEY header. Its prices are Australia
// Post's PUBLISHED rates, not a contract account's. International is priced by country and weight; domestic also by size.
//   AUSPOST_PAC_KEY        the key (required)
//   AUSPOST_FROM_POSTCODE  where parcels are sent from (default 3061, Campbellfield VIC)
//   AUSPOST_PAC_URL        only to point at a different address (default https://digitalapi.auspost.com.au)
export class AusPostError extends Error {
  constructor(message: string, readonly kind: 'not_configured' | 'auth' | 'bad_request' | 'unavailable') { super(message); }
}
export type Service = { code: string; name: string; price: number };
const DEFAULT_URL = 'https://digitalapi.auspost.com.au';
const SERVICES_TTL = 10 * 60_000, COUNTRIES_TTL = 24 * 60 * 60_000;

export const configured = () => !!(process.env.AUSPOST_PAC_KEY ?? '').trim();
export const fromPostcode = () => (process.env.AUSPOST_FROM_POSTCODE ?? '').trim() || '3061';

const cache = new Map<string, { at: number; data: any }>();
export const clearAusPostCache = () => cache.clear();
const asArray = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);   // AusPost sends one result as an object, not a list
// "12.50" and "$12.50" are prices. Text with no digit in it ("free", "") is not a price, and must never read as $0.00.
const priceOf = (v: unknown): number | null => { const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, ''); if (!/\d/.test(cleaned)) return null; const n = Number(cleaned); return Number.isFinite(n) ? n : null; };

async function pac(path: string, params: Record<string, string | number>, ttl: number): Promise<any> {
  const key = (process.env.AUSPOST_PAC_KEY ?? '').trim();
  if (!key) throw new AusPostError('AusPost is not set up yet: the AUSPOST_PAC_KEY setting is missing on the server.', 'not_configured');
  const url = `${(process.env.AUSPOST_PAC_URL ?? '').trim() || DEFAULT_URL}${path}?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)])).toString()}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  let lastError: AusPostError | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {   // one more go if the network or AusPost stumbles
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(process.env.AUSPOST_TIMEOUT_MS) > 0 ? Number(process.env.AUSPOST_TIMEOUT_MS) : 10_000);
    try {
      const res = await fetch(url, { headers: { 'AUTH-KEY': key, Accept: 'application/json' }, signal: ctl.signal });
      const text = await res.text();
      let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      if (res.status === 401 || res.status === 403) throw new AusPostError('AusPost rejected the API key (AUSPOST_PAC_KEY). Check it is the Postage Assessment Calculator key.', 'auth');
      if (res.status === 400 || res.status === 404 || res.status === 422) {
        const why = body?.error?.errorMessage ?? body?.error?.message ?? body?.message;
        throw new AusPostError(`AusPost could not price that: ${why ?? `it answered ${res.status}`}`, 'bad_request');
      }
      if (res.status === 429 || res.status >= 500) { lastError = new AusPostError(res.status === 429 ? 'AusPost says too many requests: try again in a minute.' : 'AusPost is not answering at the moment: try again shortly.', 'unavailable'); continue; }
      if (!res.ok || body == null) throw new AusPostError(`AusPost gave an answer I could not read (${res.status}).`, 'unavailable');
      cache.set(url, { at: Date.now(), data: body });
      if (cache.size > 500) cache.clear();
      return body;
    } catch (e) {
      if (e instanceof AusPostError && e.kind !== 'unavailable') throw e;
      lastError = e instanceof AusPostError ? e : new AusPostError(ctl.signal.aborted ? 'AusPost took too long to answer: try again shortly.' : 'Could not reach AusPost: try again shortly.', 'unavailable');
    } finally { clearTimeout(timer); }
  }
  throw lastError ?? new AusPostError('Could not reach AusPost.', 'unavailable');
}

function servicesFrom(body: any): Service[] {
  const out: Service[] = [];
  for (const s of asArray<any>(body?.services?.service)) {
    const price = priceOf(s?.price);
    if (s?.code && price != null && price >= 0) out.push({ code: String(s.code), name: String(s.name ?? s.code), price });
  }
  return out;
}

// What each international service costs for one parcel of this weight to this country (an ISO code such as NZ).
export async function internationalServices(countryCode: string, weightKg: number): Promise<Service[]> {
  return servicesFrom(await pac('/postage/parcel/international/service.json', { country_code: countryCode.toUpperCase(), weight: Math.round(weightKg * 1000) / 1000 }, SERVICES_TTL));
}

// What each Australian service costs for one parcel of this size and weight, from the ship-from postcode to a postcode.
export async function domesticServices(p: { toPostcode: string; lengthCm: number; widthCm: number; heightCm: number; weightKg: number; from?: string }): Promise<Service[]> {
  return servicesFrom(await pac('/postage/parcel/domestic/service.json', {
    from_postcode: p.from ?? fromPostcode(), to_postcode: p.toPostcode,
    length: p.lengthCm, width: p.widthCm, height: p.heightCm, weight: Math.round(p.weightKg * 1000) / 1000,
  }, SERVICES_TTL));
}

// Names people use that AusPost's list does not.
const ALIASES: Record<string, string> = {
  'nz': 'NZ', 'new zealand': 'NZ', 'aotearoa': 'NZ',
  'us': 'US', 'usa': 'US', 'u.s.': 'US', 'u.s.a.': 'US', 'america': 'US', 'united states': 'US', 'united states of america': 'US',
  'uk': 'GB', 'u.k.': 'GB', 'gb': 'GB', 'great britain': 'GB', 'britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB', 'united kingdom': 'GB',
  'uae': 'AE', 'emirates': 'AE', 'south korea': 'KR', 'korea': 'KR', 'hong kong': 'HK', 'holland': 'NL', 'the netherlands': 'NL',
  'australia': 'AU', 'au': 'AU', 'aus': 'AU',
};
let countryList: { at: number; list: { code: string; name: string }[] } | null = null;
async function countries(): Promise<{ code: string; name: string }[]> {
  if (countryList && Date.now() - countryList.at < COUNTRIES_TTL) return countryList.list;
  const body = await pac('/postage/country.json', {}, COUNTRIES_TTL);
  const list = asArray<any>(body?.countries?.country).filter(c => c?.code).map(c => ({ code: String(c.code).toUpperCase(), name: String(c.name ?? c.code) }));
  countryList = { at: Date.now(), list };
  return list;
}
export const clearCountries = () => { countryList = null; };

// "New Zealand", "nz", "USA", "united kingdom" -> { code: 'NZ', name: 'New Zealand' }. null when it is not a country AusPost sends to.
export async function resolveCountry(input: string): Promise<{ code: string; name: string } | null> {
  const q = String(input ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return null;
  const titled = (s: string) => s.toLowerCase().replace(/(^|[\s(-])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  const alias = ALIASES[q];
  let list: { code: string; name: string }[] = [];
  try { list = await countries(); } catch (e) { if (!(e instanceof AusPostError) || e.kind === 'not_configured' || e.kind === 'auth') throw e; }
  const byCode = (code: string) => { const c = list.find(x => x.code === code); return c ? { code, name: titled(c.name) } : list.length ? null : { code, name: code }; };
  if (alias) return alias === 'AU' ? { code: 'AU', name: 'Australia' } : byCode(alias) ?? null;
  if (/^[a-z]{2}$/.test(q)) return byCode(q.toUpperCase());
  const exact = list.filter(c => c.name.toLowerCase() === q);
  if (exact.length === 1) return { code: exact[0].code, name: titled(exact[0].name) };
  const partial = list.filter(c => c.name.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q));
  return partial.length === 1 ? { code: partial[0].code, name: titled(partial[0].name) } : null;
}