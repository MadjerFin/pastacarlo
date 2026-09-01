import { Router, Request, Response } from 'express';
import { queueState } from '../services/queueState';
import { fetchRoomInfo, findContactTokenByPhone, fetchVisitorInfo, parseRcDate } from '../services/rocketchatApi';
import { botRateLimit } from '../middleware/botRateLimit';

const router = Router();

// URL do widget de livechat com o token do visitante — usada para redirecionar
// quem já está com um agente conectado direto pro chat.
function buildAgentUrl(visitorToken: string): string {
  const livechatBaseUrl = process.env.ROCKETCHAT_LIVECHAT_URL ?? `${process.env.ROCKETCHAT_URL ?? ''}/livechat`;
  return `${livechatBaseUrl}?token=${encodeURIComponent(visitorToken)}`;
}

function appBaseUrl(): string {
  return (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

// Página do próprio app (WaitingRoom) — serve tanto pra fila quanto pra chat
// já conectado: ela abre um SSE e troca de tela sozinha (fila → chat) sem
// precisar de outro link. nome/tel são opcionais, mas sem eles o botão
// "Iniciar novo atendimento" dentro do chat (se a sala fechar depois) cai
// num reload que reabre a mesma sala fechada em vez de oferecer uma nova.
function buildAppLink(visitorToken: string, roomId?: string, name?: string, phone?: string): string {
  const params = new URLSearchParams({ token: visitorToken });
  if (roomId) params.set('room', roomId);
  if (name) params.set('nome', name);
  if (phone) params.set('tel', phone);
  return `${appBaseUrl()}/?${params.toString()}`;
}

// Fluxo de registro/abertura de sala nova (EntryPage) — exige nome e telefone.
function buildEntrarLink(name: string, phone: string): string {
  const params = new URLSearchParams({ nome: name, tel: phone });
  return `${appBaseUrl()}/entrar?${params.toString()}`;
}

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
      queueState.enqueue(roomId, rc.visitorToken, rc.createdAt);
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
    queueSize: status === 'queued' ? queueState.getQueuedCount() : null,
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
      queueState.enqueue(rc.roomId, token, rc.createdAt);
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
    queueSize: status === 'queued' ? queueState.getQueuedCount() : null,
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
    queueSize: entry.status === 'queued' ? queueState.getQueuedCount() : null,
    agentUrl: entry.agentUrl ?? null,
    enteredAt: entry.enteredAt,
  });
});

async function checkRcRoomStatus(visitorToken: string): Promise<{ status: 'queued' | 'connected' | 'none'; roomId?: string; createdAt?: number }> {
  const base = process.env.ROCKETCHAT_URL;
  try {
    const res = await fetch(`${base}/api/v1/livechat/room?token=${encodeURIComponent(visitorToken)}`);
    if (!res.ok) return { status: 'none' };
    const body = await res.json() as { room?: { _id?: string; open?: boolean; servedBy?: unknown; ts?: unknown }; success?: boolean };
    const room = body.room;
    if (!room?._id || !room.open) return { status: 'none' };
    return {
      status: room.servedBy ? 'connected' : 'queued',
      roomId: room._id,
      createdAt: parseRcDate(room.ts),
    };
  } catch {
    return { status: 'none' };
  }
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
        queueSize: queueState.getQueuedCount(),
        estimatedWaitSeconds: undefined,
      });
    } else if (entry.status === 'connected' && entry.agentUrl !== undefined) {
      // Re-send connected if already known (e.g. browser tab reopen)
      send('connected', { agentUrl: entry.agentUrl, roomId: entry.roomId });
    }
  } else {
    // No local state — check RC directly to recover from backend restarts
    checkRcRoomStatus(visitorToken).then(({ status, roomId, createdAt }) => {
      if (status === 'connected' && roomId) {
        // Agent already took the chat — immediately open it
        queueState.markConnected(roomId, visitorToken, buildAgentUrl(visitorToken));
      } else if (status === 'queued' && roomId) {
        // Still in queue — re-add to local state so position tracking works,
        // using RC's real creation time so the position doesn't jump to the back
        queueState.enqueue(roomId, visitorToken, createdAt);
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
