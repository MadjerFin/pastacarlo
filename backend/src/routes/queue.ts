import { Router, Request, Response } from 'express';
import { queueState } from '../services/queueState';
import { fetchRoomInfo } from '../services/rocketchatApi';

const router = Router();

// GET /queue/room/:roomId — posição na fila e status aberto/fechado da sala,
// identificados pelo roomId do Rocket.Chat (não pelo visitorToken).
router.get('/room/:roomId', async (req: Request, res: Response) => {
  const { roomId } = req.params;

  let entry = queueState.getEntryByRoomId(roomId);
  const rc = await fetchRoomInfo(roomId);

  if (!entry && !rc) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }

  // Self-heal: RC knows about a queued room we don't (backend restart, missed
  // webhook) — re-add it using RC's real creation time so it lands in the
  // correct position instead of jumping to the back of the queue.
  if (!entry && rc?.open && !rc.servedBy && rc.visitorToken) {
    queueState.enqueue(roomId, rc.visitorToken, rc.createdAt);
    entry = queueState.getEntryByRoomId(roomId);
  }

  // room.open (Rocket.Chat) é a fonte da verdade; o estado local cobre o caso
  // de queda do backend em que rooms.info ainda não foi confirmado.
  const open = rc?.open ?? (entry?.status === 'queued' || entry?.status === 'connected');
  const status: 'queued' | 'connected' | 'closed' =
    entry?.status ?? (open ? (rc?.servedBy ? 'connected' : 'queued') : 'closed');

  res.json({
    ok: true,
    roomId,
    open,
    status,
    position: status === 'queued' ? entry?.position ?? null : null,
    queueSize: status === 'queued' ? queueState.getQueuedCount() : null,
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
    const body = await res.json() as { room?: { _id?: string; open?: boolean; servedBy?: unknown; ts?: string }; success?: boolean };
    const room = body.room;
    if (!room?._id || !room.open) return { status: 'none' };
    return {
      status: room.servedBy ? 'connected' : 'queued',
      roomId: room._id,
      createdAt: room.ts ? new Date(room.ts).getTime() : undefined,
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
        const agentUrl = '';
        queueState.markConnected(roomId, visitorToken, agentUrl);
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
