import type { Request, Response, NextFunction } from 'express';

// Times every request, so slowness can be measured instead of guessed:
//   - a Server-Timing header on each answer (in the browser: Network tab > the request > Timing), the time the API took.
//   - rolling per-route figures (the last 200 requests of each route: median, slowest 5%, worst), shown by /speed.
//   - a line in the log for any request slower than SLOW_REQUEST_MS (default 1500): "SLOW GET /orders/views/quotes 2310 ms".
// Routes are grouped by pattern (/orders/:id), not by the actual id, so one slow kind of page shows up as one row.
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS) || 1500;
const KEEP = 200;
const stats = new Map<string, number[]>();

export function routeKey(req: Request): string {
  if (!req.route) return `${req.method} (no route)`;
  let path = `${req.baseUrl}${req.route.path ?? ''}`.replace(/\/+$/, '') || '/';
  // The Orders views are one route with four very different jobs (quotes, to-ship, unpaid, balances): show which, so a slow one is not averaged into the
  // fast ones. Only these known names are used, so a made-up one cannot add entries.
  const view = (req.params as Record<string, unknown> | undefined)?.view;
  if (typeof view === 'string' && path.includes(':view') && ['quotes', 'to-ship', 'unpaid', 'balances'].includes(view)) path = path.replace(':view', view);
  return `${req.method} ${path}`;
}

export function requestTiming() {
  return (req: Request, res: Response, next: NextFunction) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const writeHead = res.writeHead;
    res.writeHead = function (this: Response, ...args: any[]) {
      if (!this.headersSent && !this.getHeader('Server-Timing')) this.setHeader('Server-Timing', `app;dur=${ms().toFixed(1)}`);
      return (writeHead as any).apply(this, args);
    } as any;
    res.on('finish', () => {
      const url = req.originalUrl.split('?')[0];
      if (url === '/health' || url.startsWith('/speed')) return;   // looking at the numbers must not change them
      const dur = ms(), key = routeKey(req);
      const list = stats.get(key) ?? [];
      list.push(dur); if (list.length > KEEP) list.shift();
      stats.set(key, list);
      const streaming = String(res.getHeader('Content-Type') ?? '').includes('text/event-stream');   // a live answer is long by nature
      if (dur >= SLOW_MS && !streaming) console.warn(`SLOW ${req.method} ${url} ${Math.round(dur)} ms (status ${res.statusCode}, route ${key})`);
    });
    next();
  };
}

// The routes with the slowest worst-5%, most useful first.
export function slowestRoutes(n = 12) {
  const round = (v: number) => Math.round(v * 10) / 10;
  return [...stats].map(([route, d]) => {
    const s = [...d].sort((a, b) => a - b), q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { route, requests: d.length, medianMs: round(q(0.5)), slowest5PercentMs: round(q(0.95)), worstMs: round(s[s.length - 1]) };
  }).sort((a, b) => b.slowest5PercentMs - a.slowest5PercentMs).slice(0, n);
}

export function resetTiming() { stats.clear(); }\\