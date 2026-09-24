/**
 * Thin client for the DEAR Core (Cin7 Core) External API.
 * Endpoint paths, response shapes, and rate limiting confirmed
 * against your own working Pantone fulfillment app's edge function
 * — not guessed. See comments below for what's confirmed vs not.
 */
const BASE_URL = 'https://inventory.dearsystems.com/ExternalApi/v2';

function headers() {
  return {
    'api-auth-accountid': process.env.CIN7_ACCOUNT_ID!,
    'api-auth-applicationkey': process.env.CIN7_APPLICATION_KEY!,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Shared clock so no two calls in one run can burst together —
// confirmed real limit is 60 req/min, 1100ms gap keeps well under it.
let lastCallAt = 0;
async function throttle() {
  const minGapMs = 1100;
  const wait = lastCallAt + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

export async function dearGet(path: string, params: Record<string, string | number> = {}, retried = false): Promise<any> {
  await throttle();
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString(), { headers: headers() });
  const text = await res.text();

  if (res.status === 429) {
    if (!retried) {
      console.warn('Rate limited, waiting 61s before one retry...');
      await sleep(61000);
      return dearGet(path, params, true);
    }
    throw new Error(`DEAR API ${path} rate limited even after waiting.`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    // This is how a wrong path shows up — DEAR serves its own web app's
    // HTML (e.g. a "Page not found") instead of an API error.
    throw new Error(`DEAR API ${path} returned content-type "${contentType || 'unknown'}" (HTTP ${res.status}) — endpoint path is likely wrong. Body: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    throw new Error(`DEAR API ${path} failed: ${res.status} ${text.slice(0, 300)}`);
  }

  return JSON.parse(text);
}

/** Every customer in DEAR, paginated. Confirmed working as-is. */
export async function fetchAllCustomers(): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const data = await dearGet('/customer', { Page: page, Limit: limit });
    const batch = data.Customers ?? data.CustomerList ?? [];
    all.push(...batch);
    if (batch.length < limit) break;
    page++;
    if (page > 200) break;
  }
  return all;
}

/**
 * All products, paginated the same way as fetchAllCustomers. Used to
 * build a SKU -> Brand map once per sync run rather than looking up
 * the brand per line item (which would be an API call per line).
 * Response root key confirmed as "Products" from a real /product call.
 */
export async function fetchAllProducts(): Promise<any[]> {
  const all: any[] = [];
  let page = 1;
  const limit = 100;
  while (true) {
    const data = await dearGet('/product', { Page: page, Limit: limit });
    const batch = data.Products ?? [];
    all.push(...batch);
    if (batch.length < limit) break;
    page++;
    if (page > 500) break;
  }
  return all;
}

/**
 * Sales updated since a given date. Path confirmed: "saleList", one
 * word, no slash — /sale/list (with a slash) 404s. Response root key
 * confirmed as SaleList. List items carry the ID under SaleID.
 */
export async function fetchSalesUpdatedSince(since: Date): Promise<any[]> {
  const all = new Map<string, any>();
  let page = 1;
  const limit = 100;
  const updatedSince = since.toISOString();

  while (true) {
    const data = await dearGet('/saleList', { Page: page, Limit: limit, UpdatedSince: updatedSince });
    const batch = data.SaleList ?? [];
    for (const sale of batch) all.set(sale.SaleID, sale);
    if (batch.length < limit) break;
    page++;
    if (page > 200) break;
  }
  return [...all.values()];
}

/** Full sale detail — confirmed the param is ID, not SaleID. */
export async function fetchSaleDetail(saleId: string): Promise<any> {
  return dearGet('/sale', { ID: saleId });
}
