import { queueState } from './queueState';

interface RocketChatRoom {
  _id: string;
  open?: boolean;
  servedBy?: { _id: string; username: string };
  v?: { token: string };
  ts?: string; // room creation time (ISO) — used to order the queue correctly
  [key: string]: unknown;
}

export interface QueuedRoom {
  visitorToken: string;
  createdAt: number; // epoch ms, from room.ts
}

interface RocketChatRoomsResponse {
  rooms: RocketChatRoom[];
  count: number;
  offset: number;
  total: number;
  success: boolean;
}

const PAGE_SIZE = 50;

// Fetch open rooms that have no agent assigned yet (truly queued), keyed by
// roomId with the visitor token and real creation time — needed so the local
// queue can be rebuilt (e.g. after a backend restart) in the same order RC
// actually queued them, not the order we happen to observe them.
export async function fetchQueuedRooms(): Promise<Map<string, QueuedRoom>> {
  const base = process.env.ROCKETCHAT_URL;
  const token = process.env.ROCKETCHAT_ADMIN_TOKEN;
  const userId = process.env.ROCKETCHAT_ADMIN_USER_ID;

  const rooms = new Map<string, QueuedRoom>();
  if (!base || !token || !userId) {
    console.warn('[rcapi] Missing credentials — skipping reconcile');
    return rooms;
  }

  let offset = 0;

  while (true) {
    const url = `${base}/api/v1/livechat/rooms?open=true&count=${PAGE_SIZE}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { 'X-Auth-Token': token, 'X-User-Id': userId },
    });

    if (!res.ok) {
      console.error(`[rcapi] livechat/rooms returned ${res.status}`);
      break;
    }

    const body = (await res.json()) as RocketChatRoomsResponse;
    if (!body.success || !Array.isArray(body.rooms)) break;

    for (const room of body.rooms) {
      // A room is "queued" (waiting for human agent) when open and not yet served
      if (room.open && !room.servedBy && room.v?.token) {
        rooms.set(room._id, {
          visitorToken: room.v.token,
          createdAt: room.ts ? new Date(room.ts).getTime() : Date.now(),
        });
      }
    }

    if (offset + body.count >= body.total) break;
    offset += PAGE_SIZE;
  }

  return rooms;
}

export interface RoomInfo {
  open: boolean;
  servedBy?: unknown;
  createdAt?: number;
  visitorToken?: string;
}

// Fetch a single room's live status directly from Rocket.Chat by roomId —
// used as ground truth (independent of our in-memory queueState, which is
// lost on backend restarts and only updated via webhooks/reconciliation).
export async function fetchRoomInfo(roomId: string): Promise<RoomInfo | null> {
  const base = process.env.ROCKETCHAT_URL;
  const token = process.env.ROCKETCHAT_ADMIN_TOKEN;
  const userId = process.env.ROCKETCHAT_ADMIN_USER_ID;

  if (!base || !token || !userId) {
    console.warn('[rcapi] Missing credentials — skipping fetchRoomInfo');
    return null;
  }

  try {
    const url = `${base}/api/v1/rooms.info?roomId=${encodeURIComponent(roomId)}`;
    const res = await fetch(url, {
      headers: { 'X-Auth-Token': token, 'X-User-Id': userId },
    });
    if (!res.ok) return null;

    const body = await res.json() as { room?: RocketChatRoom; success?: boolean };
    if (!body.success || !body.room) return null;

    return {
      open: !!body.room.open,
      servedBy: body.room.servedBy,
      createdAt: body.room.ts ? new Date(body.room.ts).getTime() : undefined,
      visitorToken: body.room.v?.token,
    };
  } catch (err) {
    console.error('[rcapi] fetchRoomInfo error:', err);
    return null;
  }
}

// Resolve a visitor's Rocket.Chat token from their phone number — used
// wherever a caller (bot, registration flow) only knows the phone, not the
// RC token or roomId.
export async function findContactTokenByPhone(phone: string): Promise<string | null> {
  const base = process.env.ROCKETCHAT_URL;
  const token = process.env.ROCKETCHAT_ADMIN_TOKEN;
  const userId = process.env.ROCKETCHAT_ADMIN_USER_ID;

  try {
    const res = await fetch(
      `${base}/api/v1/omnichannel/contact.search?phone=${encodeURIComponent(phone)}`,
      { headers: { 'X-Auth-Token': token ?? '', 'X-User-Id': userId ?? '' } },
    );
    if (!res.ok) return null;
    const body = await res.json() as { contact?: { token?: string } };
    const visitorToken = body.contact?.token ?? null;
    // Ignore tokens we generated ourselves (base64url of 'sapios:phone') — they're
    // rejected by the RC livechat page. Let RC generate a fresh one instead.
    if (visitorToken?.startsWith('c2FwaW9z')) {
      console.log('[rcapi] ignoring legacy custom token, will request fresh RC token');
      return null;
    }
    return visitorToken;
  } catch (err) {
    console.error('[rcapi] findContactTokenByPhone error:', err);
    return null;
  }
}

export interface VisitorInfo {
  name?: string;
  phone?: string;
}

// Fetch a visitor's name/phone by their RC token — used to prefill the
// "abrir nova sala" link (nome+tel são obrigatórios em /entrar) when a
// visitor's room is closed.
export async function fetchVisitorInfo(visitorToken: string): Promise<VisitorInfo | null> {
  const base = process.env.ROCKETCHAT_URL;
  const token = process.env.ROCKETCHAT_ADMIN_TOKEN;
  const userId = process.env.ROCKETCHAT_ADMIN_USER_ID;

  if (!base || !token || !userId) {
    console.warn('[rcapi] Missing credentials — skipping fetchVisitorInfo');
    return null;
  }

  try {
    const url = `${base}/api/v1/livechat/visitor/${encodeURIComponent(visitorToken)}`;
    const res = await fetch(url, {
      headers: { 'X-Auth-Token': token, 'X-User-Id': userId },
    });
    if (!res.ok) return null;

    const body = await res.json() as {
      visitor?: { name?: string; phone?: string | Array<{ phoneNumber?: string }> };
      success?: boolean;
    };
    if (!body.success || !body.visitor) return null;

    const rawPhone = body.visitor.phone;
    const phone = typeof rawPhone === 'string' ? rawPhone : rawPhone?.[0]?.phoneNumber;

    return { name: body.visitor.name, phone };
  } catch (err) {
    console.error('[rcapi] fetchVisitorInfo error:', err);
    return null;
  }
}

export async function runReconciliation(): Promise<void> {
  console.log('[rcapi] starting reconciliation...');
  try {
    const queuedRooms = await fetchQueuedRooms();
    queueState.reconcile(queuedRooms);
    console.log(`[rcapi] reconciliation done — ${queuedRooms.size} queued rooms in RC`);
  } catch (err) {
    console.error('[rcapi] reconciliation error:', err);
  }
}

export function startReconciliationJob(): void {
  const intervalSecs = parseInt(process.env.RECONCILE_INTERVAL_SECONDS ?? '30', 10);
  setInterval(runReconciliation, intervalSecs * 1000);
  console.log(`[rcapi] reconciliation job started (every ${intervalSecs}s)`);
}
