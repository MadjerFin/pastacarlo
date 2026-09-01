import { Router, Request, Response } from 'express';
import { queueState } from '../services/queueState';
import { fetchRoomInfo, findContactTokenByPhone, fetchVisitorInfo, fetchOpenRoomForVisitorToken } from '../services/rocketchatApi';
import { buildAgentUrl, buildAppLink, buildEntrarLink } from '../services/links';
import { botRateLimit } from '../middleware/botRateLimit';

const router = Router();

// Resolve o link "certo" pro status atual, pra o chamador (bot) não precisar
// montar URL nenhuma na mão.
async function resolveStatusLink(
  status: 'queued' | 'connected' | 'closed',
  visitorToken: string | undefined,
  roomId: string | null,
  knownPhone?: string,
): Promise<string | null> {
  if (!visitorToken) return null;

  const info = await fetchVisitorInfo(visitorToken);
  const phone = knownPhone ?? info?.phone;

  if (status === 'closed') {
    if (!info?.name || !phone) return null;
    return buildEntrarLink(info.name, phone);
  }

  return buildAppLink(visitorToken, roomId ?? undefined, info?.name, phone);
}

// GET /queue/room/:roomId — posição na fila e status aberto/fechado da sala,
// identificados pelo roomId do Rocket.Chat (não pelo visitorToken).
router.get('/room/:roomId', botRateLimit, async (req: Request, res: Response) => {
  const { roomId } = req.params;

  let entry = queueState.getEntryByRoomId(roomId);
  const rc = await fetchRoomInfo(roomId);

  if (!entry && !rc) {
    // Sala nunca existiu ou já não está mais na RC — trata como "fechada" em
    // vez de erro, pra o chamador não precisar tratar 404 separado de closed.
    res.json({ ok: true, roomId, open: false, status: 'closed', position: null, queueSize: null, link: null });
    return;
  }

  // Self-heal: RC knows about a room we don't (backend restart, missed
  // webhook) — re-add it so state (position, agentUrl) is available locally
  // instead of just derived from RC on every call.
  if (!entry && rc?.open && rc.visitorToken) {
    if (rc.servedBy) {
      queueState.markConnected(roomId, rc.visitorToken, buildAgentUrl(rc.visitorToken));
    } else {
      // Uses RC's real creation time so the position doesn't jump to the back.
      queueState.enqueue(roomId, rc.visitorToken, rc.departmentId ?? '', rc.createdAt);
    }
    entry = queueState.getEntryByRoomId(roomId);
  }

  // room.open (Rocket.Chat) é a fonte da verdade; o estado local cobre o caso
  // de queda do backend em que rooms.info ainda não foi confirmado.
  const open = rc?.open ?? (entry?.status === 'queued' || entry?.status === 'connected');
  const status: 'queued' | 'connected' | 'closed' =
    entry?.status ?? (open ? (rc?.servedBy ? 'connected' : 'queued') : 'closed');
  const visitorToken = entry?.visitorToken ?? rc?.visitorToken;
  const link = await resolveStatusLink(status, visitorToken, roomId);

  res.json({
    ok: true,
    roomId,
    open,
    status,
    position: status === 'queued' ? entry?.position ?? null : null,
    queueSize: status === 'queued' && entry ? queueState.getQueuedCount(entry.departmentId) : null,
    link,
  });
});

// POST /queue/phone  body: { phone }
// Como /room/:roomId, mas para quando o chamador (bot) só tem o telefone do
// visitante, não o roomId do Rocket.Chat. É POST (telefone no corpo, não na
// URL) para não deixar o número em logs de acesso, proxies ou histórico do
// navegador. Rate limit — telefone é um identificador adivinhável, diferente
// do roomId (opaco, gerado pela RC).
router.post('/phone', botRateLimit, async (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: string };
  if (!phone) {
    res.status(400).json({ ok: false, error: 'phone_required' });
    return;
  }

  const cleanPhone = phone.replace(/\D/g, '');
  const token = await findContactTokenByPhone(cleanPhone);

  if (!token) {
    // Telefone não corresponde a nenhum visitante conhecido na RC — trata como
    // "fechada" em vez de erro, pra o chamador não precisar tratar 404 separado.
    res.json({ ok: true, roomId: null, open: false, status: 'closed', position: null, queueSize: null, link: null });
    return;
  }

  let entry = queueState.getEntry(token);
  const rc = await checkRcRoomStatus(token);

  // Self-heal: RC sabe de uma sala que ainda não conhecemos localmente
  // (reinício do backend, webhook perdido).
  if (!entry && rc.roomId) {
    if (rc.status === 'connected') {
      queueState.markConnected(rc.roomId, token, buildAgentUrl(token));
    } else if (rc.status === 'queued') {
      // Usa a hora real de criação da RC pra posição não pular pro fim da fila.
      queueState.enqueue(rc.roomId, token, rc.departmentId ?? '', rc.createdAt);
    }
    entry = queueState.getEntry(token);
  }

  const open = entry
    ? entry.status === 'queued' || entry.status === 'connected'
    : rc.status !== 'none';
  const status: 'queued' | 'connected' | 'closed' =
    entry?.status ?? (rc.status === 'none' ? 'closed' : rc.status);
  const link = await resolveStatusLink(status, token, entry?.roomId ?? rc.roomId ?? null, cleanPhone);

  res.json({
    ok: true,
    roomId: entry?.roomId ?? rc.roomId ?? null,
    open,
    status,
    position: status === 'queued' ? entry?.position ?? null : null,
    queueSize: status === 'queued' && entry ? queueState.getQueuedCount(entry.departmentId) : null,
    link,
  });
});

// GET /queue/:visitorToken — snapshot do status atual
router.get('/:visitorToken', (req: Request, res: Response) => {
  const { visitorToken } = req.params;
  const entry = queueState.getEntry(visitorToken);

  if (!entry) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }

  res.json({
    ok: true,
    status: entry.status,
    position: entry.status === 'queued' ? entry.position : null,
    queueSize: entry.status === 'queued' ? queueState.getQueuedCount(entry.departmentId) : null,
    agentUrl: entry.agentUrl ?? null,
    enteredAt: entry.enteredAt,
  });
});

// Read-only status check — deliberately does NOT call RC's GET /livechat/room?
// token=... (that's what visitors.ts's openRoom() uses to actually start/resume
// a chat, and it creates a new room as a side effect when the visitor has
// none). Asks the admin rooms listing whether they have an open room —
// never creates anything, so a bot or a self-heal check can't accidentally
// open a room the visitor never asked for.
async function checkRcRoomStatus(visitorToken: string): Promise<{ status: 'queued' | 'connected' | 'none'; roomId?: string; departmentId?: string; createdAt?: number }> {
  const room = await fetchOpenRoomForVisitorToken(visitorToken);
  if (room?.open) {
    return {
      status: room.servedBy ? 'connected' : 'queued',
      roomId: room.roomId,
      departmentId: room.departmentId,
      createdAt: room.createdAt,
    };
  }

  // The bulk listing above can miss a room that's genuinely still open in RC
  // (confirmed live: RC's own dashboard showed it queued while this listing
  // didn't). Fall back to the visitor's last-known room and confirm it
  // directly — a targeted, single-room lookup that doesn't share whatever
  // blind spot the bulk listing has.
  const info = await fetchVisitorInfo(visitorToken);
  if (info?.lastChatRoomId) {
    const fallback = await fetchRoomInfo(info.lastChatRoomId);
    if (fallback?.open) {
      return {
        status: fallback.servedBy ? 'connected' : 'queued',
        roomId: info.lastChatRoomId,
        departmentId: fallback.departmentId,
        createdAt: fallback.createdAt,
      };
    }
  }

  return { status: 'none' };
}

// GET /queue/stream/:visitorToken — SSE stream
router.get('/stream/:visitorToken', (req: Request, res: Response) => {
  const { visitorToken } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // client disconnected
    }
  };

  // Register SSE client first so any concurrent webhook can find it
  queueState.addSseClient(visitorToken, res);

  // Send current state from in-memory queue
  const entry = queueState.getEntry(visitorToken);
  if (entry) {
    if (entry.status === 'queued') {
      send('queue_update', {
        position: entry.position,
        queueSize: queueState.getQueuedCount(entry.departmentId),
        estimatedWaitSeconds: undefined,
      });
    } else if (entry.status === 'connected' && entry.agentUrl !== undefined) {
      // Re-send connected if already known (e.g. browser tab reopen)
      send('connected', { agentUrl: entry.agentUrl, roomId: entry.roomId });
    }
  } else {
    // No local state — check RC directly to recover from backend restarts
    checkRcRoomStatus(visitorToken).then(({ status, roomId, departmentId, createdAt }) => {
      if (status === 'connected' && roomId) {
        // Agent already took the chat — immediately open it
        queueState.markConnected(roomId, visitorToken, buildAgentUrl(visitorToken));
      } else if (status === 'queued' && roomId) {
        // Still in queue — re-add to local state so position tracking works,
        // using RC's real creation time so the position doesn't jump to the back
        queueState.enqueue(roomId, visitorToken, departmentId ?? '', createdAt);
      } else {
        send('waiting', { message: 'Aguardando registro na fila...' });
      }
    }).catch(() => {
      send('waiting', { message: 'Aguardando registro na fila...' });
    });
  }

  // Heartbeat every 25s
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    queueState.removeSseClient(visitorToken, res);
    console.log(`[sse] client disconnected token=${visitorToken}`);
  });
});

export default router;
