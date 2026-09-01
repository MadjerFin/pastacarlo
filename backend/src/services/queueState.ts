import { Response } from 'express';

export type VisitorStatus = 'queued' | 'connected' | 'closed';

export interface VisitorEntry {
  roomId: string;
  visitorToken: string;
  status: VisitorStatus;
  position: number;
  enteredAt: number; // epoch ms
  agentUrl?: string; // populated when status = 'connected'
}

// SSE client: one visitor can have multiple browser tabs
type SseClient = Response;

class QueueState {
  // visitorToken -> entry
  private entries = new Map<string, VisitorEntry>();
  // visitorToken -> set of SSE response objects
  private sseClients = new Map<string, Set<SseClient>>();
  // roomId -> visitorToken (reverse index for webhook lookups)
  private roomIndex = new Map<string, string>();

  // ── Queue mutation ──────────────────────────────────────────────────────────

  // `createdAt` is the room's real creation time in Rocket.Chat (epoch ms), when
  // known — used instead of Date.now() so the position reflects the actual order
  // visitors entered the RC queue, not the order our backend observed them (which
  // can differ after a restart, a missed webhook, or a reconciliation self-heal).
  enqueue(roomId: string, visitorToken: string, createdAt?: number): void {
    if (this.entries.has(visitorToken)) {
      // idempotent: already in queue — just make sure status is correct
      const entry = this.entries.get(visitorToken)!;
      if (entry.status !== 'queued') {
        entry.status = 'queued';
        entry.agentUrl = undefined;
      }
      if (createdAt !== undefined) entry.enteredAt = createdAt;
    } else {
      const entry: VisitorEntry = {
        roomId,
        visitorToken,
        status: 'queued',
        position: 0, // recalculated below
        enteredAt: createdAt ?? Date.now(),
      };
      this.entries.set(visitorToken, entry);
      this.roomIndex.set(roomId, visitorToken);
    }
    this.recalcPositions();
    this.broadcastQueueUpdate();
    console.log(`[queue] enqueue  roomId=${roomId} token=${visitorToken} pos=${this.entries.get(visitorToken)?.position}`);
  }

  markConnected(roomId: string, visitorToken: string, agentUrl: string): void {
    const token = this.roomIndex.get(roomId) ?? visitorToken;

    const entry = this.entries.get(token);
    if (entry) {
      entry.status = 'connected';
      entry.agentUrl = agentUrl;
      this.recalcPositions();
      this.broadcastQueueUpdate();
    }

    this.notifyConnected(token, agentUrl, roomId);
    console.log(`[queue] connected roomId=${roomId} token=${token}`);
  }

  remove(roomId: string): void {
    const token = this.roomIndex.get(roomId);
    if (!token) return;
    const wasQueued = this.entries.get(token)?.status === 'queued';
    this.entries.delete(token);
    this.roomIndex.delete(roomId);
    if (wasQueued) this.notifyRemoved(token);
    this.recalcPositions();
    this.broadcastQueueUpdate();
    console.log(`[queue] removed  roomId=${roomId} token=${token}`);
  }

  // ── Reconciliation (called from the periodic job) ─────────────────────────

  // `activeRoomIds` is every room RC still has open+unserved — the ground truth
  // for removal. `addable` is the subset of those where we could also resolve a
  // visitor token, usable for self-heal (re-adding). These are kept separate
  // because the RC listing endpoint doesn't always populate the visitor token
  // per room; treating its absence as "not queued" would wrongly evict a room
  // that's still genuinely waiting, only for it to reappear as position 1 the
  // next time its visitor's tab (re)connects — since by then it'd be the only
  // entry left locally.
  reconcile(activeRoomIds: Set<string>, addable: Map<string, { visitorToken: string; createdAt: number }>): void {
    let changed = false;

    // Remove entries for rooms that are no longer in the Rocket.Chat queue
    for (const [roomId, token] of this.roomIndex.entries()) {
      const entry = this.entries.get(token);
      if (entry?.status === 'queued' && !activeRoomIds.has(roomId)) {
        this.entries.delete(token);
        this.roomIndex.delete(roomId);
        this.notifyRemoved(token);
        changed = true;
        console.log(`[queue] reconcile removed stale roomId=${roomId}`);
      }
    }

    // Self-heal: add rooms RC has queued but we don't know about (e.g. after a
    // backend restart, or a missed webhook), using RC's real creation time so
    // they land in the correct position instead of jumping to the back.
    for (const [roomId, { visitorToken, createdAt }] of addable.entries()) {
      if (!this.roomIndex.has(roomId)) {
        this.enqueue(roomId, visitorToken, createdAt);
        changed = true;
        console.log(`[queue] reconcile added missing roomId=${roomId}`);
      }
    }

    if (changed) {
      this.recalcPositions();
      this.broadcastQueueUpdate();
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getEntry(visitorToken: string): VisitorEntry | undefined {
    return this.entries.get(visitorToken);
  }

  getEntryByRoomId(roomId: string): VisitorEntry | undefined {
    const token = this.roomIndex.get(roomId);
    return token ? this.entries.get(token) : undefined;
  }

  getQueuedCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.status === 'queued') n++;
    return n;
  }

  // ── SSE ──────────────────────────────────────────────────────────────────

  addSseClient(visitorToken: string, res: SseClient): void {
    if (!this.sseClients.has(visitorToken)) {
      this.sseClients.set(visitorToken, new Set());
    }
    this.sseClients.get(visitorToken)!.add(res);
  }

  removeSseClient(visitorToken: string, res: SseClient): void {
    this.sseClients.get(visitorToken)?.delete(res);
  }

  private sendSse(res: SseClient, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // client disconnected mid-write — ignore
    }
  }

  private notifyConnected(token: string, agentUrl: string, roomId: string): void {
    const clients = this.sseClients.get(token);
    if (!clients) return;
    for (const res of clients) {
      this.sendSse(res, 'connected', { agentUrl, roomId });
    }
  }

  // Tells a visitor's open SSE tab(s) their queue entry was evicted (room
  // closed, or no longer seen as queued by RC) and closes the stream. Without
  // this, an evicted client's tab keeps showing whatever position/queueSize
  // it last received — frozen forever, since nothing else notifies it once
  // it's no longer in `entries` to receive future broadcastQueueUpdate calls.
  // Closing the connection makes the browser's EventSource auto-reconnect,
  // which re-runs the self-heal check with the visitor's current real status.
  private notifyRemoved(token: string): void {
    const clients = this.sseClients.get(token);
    if (!clients) return;
    for (const res of clients) {
      this.sendSse(res, 'waiting', { message: 'Verificando sua posição na fila...' });
      try {
        res.end();
      } catch {
        // already closed
      }
    }
  }

  // Broadcast position updates to all queued visitors
  private broadcastQueueUpdate(): void {
    for (const [token, entry] of this.entries.entries()) {
      if (entry.status !== 'queued') continue;
      const clients = this.sseClients.get(token);
      if (!clients || clients.size === 0) continue;
      const payload = {
        position: entry.position,
        queueSize: this.getQueuedCount(),
        estimatedWaitSeconds: this.estimateWait(entry.position),
      };
      for (const res of clients) {
        this.sendSse(res, 'queue_update', payload);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private recalcPositions(): void {
    const queued = [...this.entries.values()]
      .filter((e) => e.status === 'queued')
      .sort((a, b) => a.enteredAt - b.enteredAt);

    queued.forEach((e, i) => {
      e.position = i + 1;
    });
  }

  // Rough estimate: assume each agent handles a chat in ~5 minutes
  private estimateWait(position: number): number {
    const avgHandleTimeSeconds = 300;
    return (position - 1) * avgHandleTimeSeconds;
  }
}

export const queueState = new QueueState();
