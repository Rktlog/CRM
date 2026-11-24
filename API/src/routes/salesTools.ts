import { Router } from 'express';
import * as st from '../lib/salesTools';

// Sales Tools: the team's saved links and email templates. Nothing here sends an email.
//   GET  /sales-tools/links                       the saved links (anyone signed in)
//   POST /sales-tools/links                       { name, url, note? }  add one (any rep)
//   POST /sales-tools/links/:id                   { name, url, note? }  change one (any rep; a name used by a template cannot change)
//   POST /sales-tools/links/:id/delete            managers only, and not while a template uses it
//   GET  /sales-tools/templates                   every template, and the fill-in words
//   POST /sales-tools/templates                   { name, subject, body }  a new team template (any rep)
//   POST /sales-tools/templates/:key              { name?, subject, body }  save (the payment reminder, abandoned cart and order email: managers only)
//   POST /sales-tools/templates/:key/delete       managers only: a team template is removed, a built-in one goes back to today's wording
//   POST /sales-tools/templates/preview           { subject, body }  how it looks with made-up details, and what is wrong with it
export const salesToolsRouter = Router();
const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof st.ToolsError) return res.status(e.status).json({ error: e.message });
  console.error(`sales tools ${what} failed`, String((e as Error)?.message ?? e).slice(0, 200));
  res.status(500).json({ error: 'Something went wrong. Try again.' });
};
const rep = (req: any) => ({ id: req.rep!.id as string, role: req.rep!.role as string });

salesToolsRouter.get('/links', async (_req, res) => { try { res.json(await st.listLinks()); } catch (e) { fail(res, e, 'list links'); } });
salesToolsRouter.post('/links', async (req, res) => { try { res.json(await st.addLink(rep(req), req.body)); } catch (e) { fail(res, e, 'add link'); } });
salesToolsRouter.post('/links/:id', async (req, res) => { try { res.json(await st.editLink(rep(req), String(req.params.id), req.body)); } catch (e) { fail(res, e, 'edit link'); } });
salesToolsRouter.post('/links/:id/delete', async (req, res) => { try { await st.deleteLink(rep(req), String(req.params.id)); res.json({ ok: true }); } catch (e) { fail(res, e, 'delete link'); } });

salesToolsRouter.get('/templates', async (_req, res) => { try { res.json(await st.listTemplates()); } catch (e) { fail(res, e, 'list templates'); } });
salesToolsRouter.post('/templates/preview', async (req, res) => { try { res.json(await st.previewTemplate(req.body)); } catch (e) { fail(res, e, 'preview'); } });
salesToolsRouter.post('/templates', async (req, res) => { try { res.json(await st.createTemplate(rep(req), req.body)); } catch (e) { fail(res, e, 'create template'); } });
salesToolsRouter.post('/templates/:key', async (req, res) => { try { await st.saveTemplate(rep(req), String(req.params.key), req.body); res.json({ ok: true }); } catch (e) { fail(res, e, 'save template'); } });
salesToolsRouter.post('/templates/:key/delete', async (req, res) => { try { await st.removeTemplate(rep(req), String(req.params.key)); res.json({ ok: true }); } catch (e) { fail(res, e, 'delete template'); } });
