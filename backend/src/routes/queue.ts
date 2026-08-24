import { Router, Request, Response } from 'express';
import { queueState } from '../services/queueState';

const router = Router();

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

async function checkRcRoomStatus(visitorToken: string): Promise<{ status: 'queued' | 'connected' | 'none'; roomId?: string } > {
  const base = process.env.ROCKETCHAT_URL;
  try {
    const res = await fetch(`${base}/api/v1/livechat/room?token=${encodeURIComponent(visitorToken)}`);
    if (!res.ok) return { status: 'none' };
    const body = await res.json() as { room?: { _id?: string; open?: boolean; servedBy?: unknown }; success?: boolean };
    const room = body.room;
    if (!room?._id || !room.open) return { status: 'none' };
    return {
      status: room.servedBy ? 'connected' : 'queued',
      roomId: room._id,
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
    checkRcRoomStatus(visitorToken).then(({ status, roomId }) => {
      if (status === 'connected' && roomId) {
        // Agent already took the chat — immediately open it
        const agentUrl = '';
        queueState.markConnected(roomId, visitorToken, agentUrl);
      } else if (status === 'queued' && roomId) {
        // Still in queue — re-add to local state so position tracking works
        queueState.enqueue(roomId, visitorToken);
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
