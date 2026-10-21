import type { Request, Response, NextFunction } from 'express';
import { gzip } from 'zlib';

// Compresses JSON responses for browsers that accept it. The big lists (products, orders, accounts) are repetitive text, so they
// shrink by 5 to 10 times, which is most of the time a page spends waiting on a slower link. Only res.json is wrapped, so the
// assistant's live stream, file downloads (Excel), and anything else are left exactly as they were. Small answers are not worth it.
export function gzipJson(minBytes = 1024) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'HEAD' || !/\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) return next();
    const plain = res.json.bind(res);
    res.json = (body?: any) => {
      if (res.headersSent || res.getHeader('Content-Encoding')) return plain(body);
      let text: string;
      try { text = JSON.stringify(body); } catch { return plain(body); }
      if (text === undefined || text.length < minBytes) return plain(body);
      res.vary('Accept-Encoding');
      gzip(text, (err, packed) => {
        if (res.headersSent) return;
        if (err) { res.removeHeader('Vary'); return void plain(body); }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', packed.length);
        res.end(packed);
      });
      return res;
    };
    next();
  };
}