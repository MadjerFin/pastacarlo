import { Router, Request, Response } from 'express';
import multer from 'multer';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const RC = () => process.env.ROCKETCHAT_URL ?? '';
const rcAuthHeaders = () => ({
  'X-Auth-Token': process.env.ROCKETCHAT_ADMIN_TOKEN ?? '',
  'X-User-Id': process.env.ROCKETCHAT_ADMIN_USER_ID ?? '',
});

// GET /chat/history/:visitorToken?currentRoomId=ROOM_ID
// Returns messages from the visitor's past (already closed) rooms, so a
// returning visitor sees earlier conversations alongside the new one.
router.get('/history/:visitorToken', async (req: Request, res: Response) => {
  const { visitorToken } = req.params;
  const currentRoomId = req.query.currentRoomId as string | undefined;

  try {
    const visitorRes = await fetch(`${RC()}/api/v1/livechat/visitor/${encodeURIComponent(visitorToken)}`, {
      headers: rcAuthHeaders(),
    });
    const visitorBody = await visitorRes.json() as {
      visitor?: { _id?: string; lastChat?: { _id?: string } };
    };
    const visitorId = visitorBody.visitor?._id;
    const lookupRoomId = currentRoomId ?? visitorBody.visitor?.lastChat?._id;
    if (!visitorId || !lookupRoomId) { res.json({ ok: true, messages: [] }); return; }

    const histRes = await fetch(
      `${RC()}/api/v1/livechat/visitors.chatHistory/room/${lookupRoomId}/visitor/${visitorId}`,
      { headers: rcAuthHeaders() },
    );
    const histBody = await histRes.json() as {
      history?: Array<{ _id: string; closedAt?: string; ts: string }>;
      success?: boolean;
    };
    const pastRooms = (histBody.history ?? []).filter((room) => room._id !== currentRoomId);

    const messageLists = await Promise.all(pastRooms.map(async (room) => {
      const msgUrl = new URL(`${RC()}/api/v1/livechat/messages.history/${room._id}`);
      msgUrl.searchParams.set('token', visitorToken);
      msgUrl.searchParams.set('limit', '100');
      const msgRes = await fetch(msgUrl.toString());
      const msgBody = await msgRes.json() as { messages?: unknown[] };
      return msgBody.messages ?? [];
    }));

    res.json({ ok: true, messages: messageLists.flat() });
  } catch (err) {
    console.error('[chat] history error:', err);
    res.status(502).json({ ok: false, error: 'upstream error' });
  }
});

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
    const body = await upstream.json() as { success?: boolean; error?: string };
    // RC responds 200 even on failure (e.g. room already closed) — surface that as a real error
    if (!body.success) {
      console.warn(`[chat] sendMessage rejected by RC: roomId=${roomId} error=${body.error}`);
      res.status(409).json(body);
      return;
    }
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
    const body = await upstream.json() as { success?: boolean; error?: string };
    if (!body.success) {
      console.warn(`[chat] upload rejected by RC: roomId=${roomId} error=${body.error}`);
      res.status(409).json(body);
      return;
    }
    res.json(body);
  } catch (err) {
    console.error('[chat] upload error:', err);
    res.status(502).json({ ok: false });
  }
});

export default router;
