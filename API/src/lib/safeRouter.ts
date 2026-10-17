import type { ErrorRequestHandler, Router } from 'express';

// Express 4 does not catch an error thrown inside an async route handler. On current Node that turns into an unhandled
// rejection and the whole API stops until the host restarts it, which is what a "502 Bad Gateway" is (and the browser
// then reports it as a CORS error, because the host's error page has no CORS headers).
// guardApp() makes every route in every router hand its errors to Express instead, errorHandler answers them as a
// normal JSON error (with the CORS headers, so the real message reaches the screen), and keepRunning() makes sure
// nothing else can stop the process.

// Wraps each route handler in one router so a thrown error, sync or async, goes to Express's error handling.
export function guard<T extends Router>(router: T): T {
  for (const layer of ((router as any).stack ?? []) as any[]) {
    if (!layer.route) continue;
    for (const l of layer.route.stack as any[]) {
      const h = l.handle;
      if (typeof h !== 'function' || h.length >= 4 || h.__guarded) continue;   // an error handler (4 arguments) is left alone
      const wrapped = (req: unknown, res: unknown, next: (e?: unknown) => void) => {
        try { const r = h(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); }
      };
      (wrapped as any).__guarded = true;
      l.handle = wrapped;
    }
  }
  return router;
}

// Every router that has been mounted on the app so far. Call it once, after the last app.use(...) of a router.
export function guardApp(app: any): void {
  const stack = ((app._router ?? app.router)?.stack ?? []) as any[];   // Express 4 keeps its routers in _router, Express 5 in router
  for (const layer of stack) if (layer.handle && Array.isArray(layer.handle.stack)) guard(layer.handle);
}

// Last in the chain. The person gets the reason; the log gets the whole error.
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  console.error(`Error in ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) { res.end(); return; }
  const why = err && typeof err === 'object' && 'message' in err ? String((err as Error).message).slice(0, 300) : '';
  res.status(500).json({ error: why ? `Something went wrong: ${why}` : 'Something went wrong' });
};

// A mistake anywhere else is written to the log instead of stopping the API.
export function keepRunning(): void {
  process.on('unhandledRejection', err => console.error('Unhandled rejection (the API kept running):', err));
  process.on('uncaughtException', err => console.error('Uncaught exception (the API kept running):', err));
}