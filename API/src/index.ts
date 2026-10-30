import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { requireAuth } from './middleware/auth';
import { accountsRouter } from './routes/accounts';
import { activityRouter } from './routes/activity';
import { orderNotesRouter } from './routes/orderNotes';
import { reportsRouter } from './routes/reports';
import { meRouter } from './routes/me';
import { budgetTargetsRouter } from './routes/budgetTargets';
import { tasksRouter } from './routes/tasks';
import { repRegionsRouter } from './routes/repRegions';
import { exportsRouter } from './routes/exports';
import { miscRouter } from './routes/misc';
import { productsRouter } from './routes/products';
import { sheetFeedRouter } from './routes/sheetFeed';
import { ordersRouter } from './routes/orders';
import { abandonedCartsRouter } from './routes/Abandonedcarts';
import { creditRouter } from './routes/credit';
import { conversionRouter } from './routes/conversion';
import { marketingRouter } from './routes/marketing';
import { marketingPublicRouter } from './routes/marketingPublic';
import { gmailRouter, gmailCallbackRouter, gmailCronRouter } from './routes/gmail';
import { calendarRouter, calendarCronRouter, calendarCallbackRouter } from './routes/calendar';
import { orderingRouter } from './routes/ordering';
import { followUpDraftsRouter } from './routes/followupDrafts';
import { customReportsRouter } from './routes/customReports';
import { summarySheetRouter } from './routes/summarySheet';
import { aiRouter } from './routes/ai';
import { guardApp, errorHandler, keepRunning } from './lib/safeRouter';
import { startGmailSchedule } from './sync/gmailJob';
import { syncStatusRouter } from './routes/syncStatus'
import { syncCronRouter } from './routes/syncCron';
import { gzipJson } from './lib/gzipJson';
import { requestTiming } from './lib/timing';
import { speedRouter } from './routes/speed';
import { prisma } from './lib/prisma';
import { startKeepWarm } from './lib/keepWarm';
import { startEmbeddedMcp, type EmbeddedMcp } from './mcp/embed';
import { assertEnvironmentIsSafe } from './lib/environmentGuard';

assertEnvironmentIsSafe();   // a sandbox (APP_ENV=staging) refuses to start if it is set up to touch the live system; on production this does nothing
keepRunning();   // a mistake in one request is logged; it can no longer stop the whole API

const app = express();
app.use(requestTiming());   // times every request: a Server-Timing header, a log line for slow ones, and the figures /speed shows
// Restricts which origins can call this API — wide-open cors() would
// let any website make authenticated requests using a stolen/leaked
// token. Set ALLOWED_ORIGINS in .env as a comma-separated list once
// deployed (e.g. your real Vercel URL); defaults to localhost for dev.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map(o => o.trim());
// maxAge: the browser asks permission before every call from the web app (a preflight) and remembers the answer for a day,
// instead of asking each time: one fewer round trip on most calls.
app.use(cors({ origin: allowedOrigins, credentials: true, maxAge: 86400 }));
app.use(gzipJson());   // big JSON answers are sent compressed
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/speed', speedRouter);   // how fast the API is and why (secret header, from SQL: select crm.call_api('/speed'))

app.use('/m', marketingPublicRouter);
app.use('/accounts', requireAuth, accountsRouter);
app.use('/activity', requireAuth, activityRouter);
app.use('/order-notes', requireAuth, orderNotesRouter);
app.use('/reports', requireAuth, reportsRouter);
app.use('/me', requireAuth, meRouter);
app.use('/budget-targets', requireAuth, budgetTargetsRouter);
app.use('/tasks', requireAuth, tasksRouter);
app.use('/rep-regions', requireAuth, repRegionsRouter);
app.use('/exports', requireAuth, exportsRouter);
app.use('/misc-orders', requireAuth, miscRouter);
app.use('/products', requireAuth, productsRouter);
app.use('/sheet-feed', sheetFeedRouter);   // read-only feeds for Google Sheets: its own secret token (SHEET_FEED_TOKEN), not a login
app.use('/custom-reports', requireAuth, customReportsRouter);
app.use('/summary-sheet', requireAuth, summarySheetRouter);   // a rep's Summary sheet (Sales Data), and the managers' Excel download (Reports)
app.use('/orders', requireAuth, ordersRouter);
app.use('/abandoned-carts', requireAuth, abandonedCartsRouter);
app.use('/credit', requireAuth, creditRouter);
app.use('/conversion', requireAuth, conversionRouter);
app.use('/marketing', requireAuth, marketingRouter);
app.use('/gmail/callback', gmailCallbackRouter);   // Google sends the rep back here: no login
app.use('/gmail-cron', gmailCronRouter);           // secret header, no login (every 15 minutes)
app.use('/gmail', requireAuth, gmailRouter);
app.use('/calendar/callback', calendarCallbackRouter);   // Google sends the rep back here: no login
app.use('/calendar-cron', calendarCronRouter);           // secret header, no login
app.use('/calendar', requireAuth, calendarRouter);       // was missing: without it every /calendar/... call was a 404
app.use('/sync-cron', syncCronRouter);          // started by Supabase's scheduler, secret header, no login
app.use('/ai', requireAuth, aiRouter);
app.use('/ordering', requireAuth, orderingRouter);   // the Ordering page (managers): what to order, from the database
app.use('/sync-status', requireAuth, syncStatusRouter);
app.use('/followup-drafts', requireAuth, followUpDraftsRouter);   // payment reminder drafts (managers)

guardApp(app);          // from here every route hands its errors to Express instead of stopping the server
app.use(errorHandler);  // and the person gets the reason as a normal error, with the CORS headers

const port = process.env.PORT || 4000;
// The Radar ordering connector for Claude (src/mcp, see EMBEDDED-MCP.md). It does nothing unless MCP_ACCESS_CODES is set, and a mistake in its settings only switches it off.
// Requests for its few addresses (/mcp, /authorize, /token, /register, /oauth/..., /.well-known/oauth-...) are handed to it here, before the API's own middleware (login,
// CORS, body parsing) sees them; every other request goes to the API exactly as before.
let mcp: EmbeddedMcp | null = null;
const server = http.createServer((req, res) => (mcp && mcp.handles(req.url) ? mcp.handle(req, res) : app(req, res)));
server.listen(port, () => {
  console.log(`API listening on :${port}`);
  void startEmbeddedMcp().then(m => { mcp = m; if (m) console.log(`Radar ordering connector is on, as database user "${m.databaseUser}"`); });
  // Open the database connections now, and keep several of them warm (a tiny query on each every minute), so the first page after a quiet spell does
  // not pay for setting up new connections (several round trips each) on top of its own work. See lib/keepWarm.ts.
  void prisma.$connect().catch(e => console.error('Database connection failed at start:', e));
  startKeepWarm();
  // Gmail is normally started by Supabase's scheduler (POST /gmail-cron). Set GMAIL_JOB=on to have this service do it itself instead.
  startGmailSchedule();
});