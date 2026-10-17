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
import { ordersRouter } from './routes/orders';
import { abandonedCartsRouter } from './routes/Abandonedcarts';
import { creditRouter } from './routes/credit';
import { conversionRouter } from './routes/conversion';
import { marketingRouter } from './routes/marketing';
import { marketingPublicRouter } from './routes/marketingPublic';
import { gmailRouter, gmailCallbackRouter, gmailCronRouter } from './routes/gmail';
import { calendarRouter, calendarCronRouter, calendarCallbackRouter } from './routes/calendar';
import { customReportsRouter } from './routes/customReports';
import { aiRouter } from './routes/ai';
import { guardApp, errorHandler, keepRunning } from './lib/safeRouter';

keepRunning();   // a mistake in one request is logged; it can no longer stop the whole API

const app = express();
// Restricts which origins can call this API — wide-open cors() would
// let any website make authenticated requests using a stolen/leaked
// token. Set ALLOWED_ORIGINS in .env as a comma-separated list once
// deployed (e.g. your real Vercel URL); defaults to localhost for dev.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map(o => o.trim());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

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
app.use('/custom-reports', requireAuth, customReportsRouter);
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
app.use('/ai', requireAuth, aiRouter);

guardApp(app);          // from here every route hands its errors to Express instead of stopping the server
app.use(errorHandler);  // and the person gets the reason as a normal error, with the CORS headers

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API listening on :${port}`));