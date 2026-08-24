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

  enqueue(roomId: string, visitorToken: string): void {
    if (this.entries.has(visitorToken)) {
      // idempotent: already in queue — just make sure status is correct
      const entry = this.entries.get(visitorToken)!;
      if (entry.status !== 'queued') {
        entry.status = 'queued';
        entry.agentUrl = undefined;
      }
    } else {
      const entry: VisitorEntry = {
        roomId,
        visitorToken,
        status: 'queued',
        position: 0, // recalculated below
        enteredAt: Date.now(),
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
    this.entries.delete(token);
    this.roomIndex.delete(roomId);
    this.recalcPositions();
    this.broadcastQueueUpdate();
    console.log(`[queue] removed  roomId=${roomId} token=${token}`);
  }

  // ── Reconciliation (called from the periodic job) ─────────────────────────

  reconcile(activeRoomIds: Set<string>): void {
    let changed = false;
    // Remove entries for rooms that are no longer in the Rocket.Chat queue
    for (const [roomId, token] of this.roomIndex.entries()) {
      const entry = this.entries.get(token);
      if (entry?.status === 'queued' && !activeRoomIds.has(roomId)) {
        this.entries.delete(token);
        this.roomIndex.delete(roomId);
        changed = true;
        console.log(`[queue] reconcile removed stale roomId=${roomId}`);
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
