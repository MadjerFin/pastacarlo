import { Router, Request, Response } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const RC = () => process.env.ROCKETCHAT_URL ?? '';

// GET /chat/messages/:roomId?token=TOKEN&since=ISO_DATE
router.get('/messages/:roomId', async (req: Request, res: Response) => {
  const { roomId } = req.params;
  const { token, since } = req.query as { token?: string; since?: string };

  if (!token) { res.status(400).json({ ok: false, error: 'token required' }); return; }

  const url = new URL(`${RC()}/api/v1/livechat/messages.history/${roomId}`);
  url.searchParams.set('token', token);
  url.searchParams.set('limit', '50');
  if (since) url.searchParams.set('ls', since);

  try {
    const upstream = await fetch(url.toString());
    const body = await upstream.json();
    res.json(body);
  } catch (err) {
    console.error('[chat] fetchMessages error:', err);
    res.status(502).json({ ok: false, error: 'upstream error' });
  }
});

// POST /chat/message  body: { token, roomId, msg }
router.post('/message', async (req: Request, res: Response) => {
  const { token, roomId, msg } = req.body as { token?: string; roomId?: string; msg?: string };
  if (!token || !roomId || !msg?.trim()) {
    res.status(400).json({ ok: false, error: 'token, roomId e msg são obrigatórios' });
    return;
  }

  try {
    const upstream = await fetch(`${RC()}/api/v1/livechat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, rid: roomId, msg }),
    });
    const body = await upstream.json();
    res.json(body);
  } catch (err) {
    console.error('[chat] sendMessage error:', err);
    res.status(502).json({ ok: false });
  }
});

// POST /chat/upload/:roomId?token=TOKEN  body: multipart with 'file' field
router.post('/upload/:roomId', upload.single('file'), async (req: Request, res: Response) => {
  const { roomId } = req.params;
  const token = req.query.token as string;
  const file = (req as Request & { file?: Express.Multer.File }).file;

  if (!token || !file) {
    res.status(400).json({ ok: false, error: 'token e file são obrigatórios' });
    return;
  }

  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname);

  try {
    const upstream = await fetch(`${RC()}/api/v1/livechat/upload/${roomId}`, {
      method: 'POST',
      headers: { 'x-visitor-token': token },
      body: form,
    });
    const body = await upstream.json();
    res.json(body);
  } catch (err) {
    console.error('[chat] upload error:', err);
    res.status(502).json({ ok: false });
  }
});

export default router;
