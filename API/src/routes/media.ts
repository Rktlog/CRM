import { Router } from 'express';
import { capabilities, deleteMedia, linkMedia, listMedia, MediaError, uploadMedia } from '../lib/media';

// Photos and videos on accounts. For every signed-in rep.
//   GET    /media/capabilities            { enabled, reason, maxPhotoMb, maxVideoMb }   can files be added right now?
//   POST   /media/upload?accountId=&activityId=   the file itself as the body (application/octet-stream), its name in X-File-Name (URL-encoded) and its type in X-File-Type
//   GET    /media?accountId=              the account's photos and videos, each with a link that shows it for a few hours
//   POST   /media/link                    { mediaIds, activityId }   ties just-uploaded files to the log entry just made
//   DELETE /media/:id                     the person who added it, or a manager
export const mediaRouter = Router();

const fail = (res: any, e: unknown, what: string) => {
  if (e instanceof MediaError) return res.status(e.status).json({ error: e.message });
  console.error(`media ${what} failed:`, e);
  return res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
};
const decode = (v: unknown): string => { try { return decodeURIComponent(String(v ?? '')); } catch { return String(v ?? ''); } };

mediaRouter.get('/capabilities', async (_req, res) => { try { res.json(await capabilities()); } catch (e) { fail(res, e, 'capabilities'); } });
mediaRouter.post('/upload', async (req, res) => {
  try {
    const len = Number(req.headers['content-length']);
    const item = await uploadMedia(req.rep!, { accountId: req.query.accountId, activityId: req.query.activityId, name: decode(req.headers['x-file-name']), type: req.headers['x-file-type'] ?? req.headers['content-type'], length: Number.isFinite(len) ? len : null }, req as unknown as AsyncIterable<Uint8Array>);
    res.status(201).json({ item });
  } catch (e) { fail(res, e, 'upload'); }
});
mediaRouter.get('/', async (req, res) => { try { res.json(await listMedia(req.rep!, req.query.accountId)); } catch (e) { fail(res, e, 'list'); } });
mediaRouter.post('/link', async (req, res) => { try { res.json(await linkMedia(req.rep!, req.body?.mediaIds, req.body?.activityId)); } catch (e) { fail(res, e, 'link'); } });
mediaRouter.delete('/:id', async (req, res) => { try { await deleteMedia(req.rep!, req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e, 'delete'); } });
