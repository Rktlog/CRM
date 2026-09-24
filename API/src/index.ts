import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { requireAuth } from './middleware/auth';
import { accountsRouter } from './routes/accounts';
import { activityRouter } from './routes/activity';
import { reportsRouter } from './routes/reports';
import { meRouter } from './routes/me';
import { budgetTargetsRouter } from './routes/budgetTargets';
import { tasksRouter } from './routes/tasks';
import { repRegionsRouter } from './routes/repRegions';
import { exportsRouter } from './routes/exports';
import { miscRouter } from './routes/misc';

const app = express();
// Restricts which origins can call this API — wide-open cors() would
// let any website make authenticated requests using a stolen/leaked
// token. Set ALLOWED_ORIGINS in .env as a comma-separated list once
// deployed (e.g. your real Vercel URL); defaults to localhost for dev.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',').map(o => o.trim());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/accounts', requireAuth, accountsRouter);
app.use('/activity', requireAuth, activityRouter);
app.use('/reports', requireAuth, reportsRouter);
app.use('/me', requireAuth, meRouter);
app.use('/budget-targets', requireAuth, budgetTargetsRouter);
app.use('/tasks', requireAuth, tasksRouter);
app.use('/rep-regions', requireAuth, repRegionsRouter);
app.use('/exports', requireAuth, exportsRouter);
app.use('/misc-orders', requireAuth, miscRouter);

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API listening on :${port}`));