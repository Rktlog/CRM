import 'dotenv/config';
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
import { customReportsRouter } from './routes/customReports';
import { summarySheetRouter } from './routes/summarySheet';
import { aiRouter } from './routes/ai';
import { guardApp, errorHandler, keepRunning } from './lib/safeRouter';
import { startGmailSchedule } from './sync/gmailJob';
import { syncCronRouter } from './routes/syncCron';
import { gzipJson } from './lib/gzipJson';
import { requestTiming } from './lib/timing';
import { speedRouter } from './routes/speed';
import { prisma } from './lib/prisma';

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

guardApp(app);          // from here every route hands its errors to Express instead of stopping the server
app.use(errorHandler);  // and the person gets the reason as a normal error, with the CORS headers

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
  // Open the database connection now, and touch it every 4 minutes, so the first page after a quiet spell does not pay for
  // setting up a new connection (several round trips) on top of its own work.
  void prisma.$connect().catch(e => console.error('Database connection failed at start:', e));
  setInterval(() => { void prisma.$queryRaw`select 1`.catch(() => {}); }, 4 * 60_000).unref();
  // Gmail is normally started by Supabase's scheduler (POST /gmail-cron). Set GMAIL_JOB=on to have this service do it itself instead.
  startGmailSchedule();
});