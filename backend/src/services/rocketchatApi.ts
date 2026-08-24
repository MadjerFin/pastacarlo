import { queueState } from './queueState';

interface RocketChatRoom {
  _id: string;
  open?: boolean;
  servedBy?: { _id: string; username: string };
  v?: { token: string };
  [key: string]: unknown;
}

interface RocketChatRoomsResponse {
  rooms: RocketChatRoom[];
  count: number;
  offset: number;
  total: number;
  success: boolean;
}

const PAGE_SIZE = 50;

// Fetch open rooms that have no agent assigned yet (truly queued)
export async function fetchQueuedRoomIds(): Promise<Set<string>> {
  const base = process.env.ROCKETCHAT_URL;
  const token = process.env.ROCKETCHAT_ADMIN_TOKEN;
  const userId = process.env.ROCKETCHAT_ADMIN_USER_ID;

  if (!base || !token || !userId) {
    console.warn('[rcapi] Missing credentials — skipping reconcile');
    return new Set();
  }

  const roomIds = new Set<string>();
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
      if (room.open && !room.servedBy) {
        roomIds.add(room._id);
      }
    }

    if (offset + body.count >= body.total) break;
    offset += PAGE_SIZE;
  }

  return roomIds;
}

export async function runReconciliation(): Promise<void> {
  console.log('[rcapi] starting reconciliation...');
  try {
    const activeRoomIds = await fetchQueuedRoomIds();
    queueState.reconcile(activeRoomIds);
    console.log(`[rcapi] reconciliation done — ${activeRoomIds.size} queued rooms in RC`);
  } catch (err) {
    console.error('[rcapi] reconciliation error:', err);
  }
}

export function startReconciliationJob(): void {
  const intervalSecs = parseInt(process.env.RECONCILE_INTERVAL_SECONDS ?? '30', 10);
  setInterval(runReconciliation, intervalSecs * 1000);
  console.log(`[rcapi] reconciliation job started (every ${intervalSecs}s)`);
}
