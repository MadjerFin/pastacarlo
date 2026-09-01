import { queueState } from './queueState';

interface RocketChatRoom {
  _id: string;
  open?: boolean;
  servedBy?: { _id: string; username: string };
  v?: { token: string };
  departmentId?: string;
  // Room creation time — used to order the queue correctly. Type is `unknown`
  // because Rocket.Chat doesn't serialize this consistently: some responses
  // send a plain ISO string, others send Mongo/BSON extended JSON
  // (`{ $date: "..." }` or `{ $date: <epoch ms> }`). See parseRcDate below.
  ts?: unknown;
  [key: string]: unknown;
}

// Parses a Rocket.Chat date field regardless of shape (ISO string, epoch ms,
// or Mongo extended JSON `{ $date: ... }`). Returns undefined — never NaN —
// on anything unparseable, so callers can safely fall back to Date.now()
// instead of accidentally sorting an entry using NaN (which corrupts queue
// ordering: a newer visitor can end up jumping ahead of everyone else).
export function parseRcDate(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (typeof value === 'object' && '$date' in (value as Record<string, unknown>)) {
    return parseRcDate((value as { $date: unknown }).$date);
  }
  return undefined;
}

export interface QueuedRoom {
  visitorToken: string;
  departmentId: string;
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

export interface QueuedRoomsResult {
  // Every open+unserved roomId — the ground truth for "is this room still
  // queued", used to decide what to remove. Doesn't depend on the listing
  // endpoint including a visitor token, which it may not always populate.
  roomIds: Set<string>;
  // Subset of the above where we could also resolve a visitor token/creation
  // time — only these can be used to self-heal (re-add) a missing entry.
  addable: Map<string, QueuedRoom>;
}

// Fetch every currently-open room (queued or already connected to an agent).
// roomIds covers ALL of them — used to detect rooms that are truly gone (i.e.
// closed), for removal. addable is the narrower subset that's still
// unserved, used to self-heal missing "queued" entries. These must stay
// separate on two counts: (1) a room that just got taken by an agent is
// still open, just no longer unserved — treating "not unserved" as "not
// open" would evict a visitor the instant they connect, before the
// LivechatSessionTaken webhook even lands; (2) `room.v.token` isn't
// guaranteed present on every room this listing returns, so requiring it for
// removal-eligibility would also incorrectly evict a still-active room.
export async function fetchQueuedRooms(): Promise<QueuedRoomsResult> {
  const base = process.env.ROCKETCHAT_URL;
  const token = process.env.ROCKETCHAT_ADMIN_TOKEN;
  const userId = process.env.ROCKETCHAT_ADMIN_USER_ID;

  const roomIds = new Set<string>();
  const addable = new Map<string, QueuedRoom>();
  if (!base || !token || !userId) {
    console.warn('[rcapi] Missing credentials — skipping reconcile');
    return { roomIds, addable };
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
      // The `open=true` query already guarantees every room here is open —
      // include all of them (served or not) so a room that just got taken by
      // an agent isn't mistaken for one that closed.
      if (!room.open) continue;
      roomIds.add(room._id);

      // Self-heal only applies to still-queued (unserved) rooms.
      if (!room.servedBy && room.v?.token && room.departmentId) {
        addable.set(room._id, {
          visitorToken: room.v.token,
          departmentId: room.departmentId,
          createdAt: parseRcDate(room.ts) ?? Date.now(),
        });
      }
    }

    if (offset + body.count >= body.total) break;
    offset += PAGE_SIZE;
  }

  return { roomIds, addable };
}

export interface RoomInfo {
  open: boolean;
  servedBy?: unknown;
  createdAt?: number;
  visitorToken?: string;
  departmentId?: string;
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
      createdAt: parseRcDate(body.room.ts),
      visitorToken: body.room.v?.token,
      departmentId: body.room.departmentId,
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
  id?: string;
  name?: string;
  phone?: string;
}

// Fetch a visitor's RC id/name/phone by their token — used both to prefill
// the "abrir nova sala" link (nome+tel são obrigatórios em /entrar) and to
// resolve the visitorId needed by fetchOpenRoomForVisitorId below.
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
      visitor?: { _id?: string; name?: string; phone?: string | Array<{ phoneNumber?: string }> };
      success?: boolean;
    };
    if (!body.success || !body.visitor) return null;

    const rawPhone = body.visitor.phone;
    const phone = typeof rawPhone === 'string' ? rawPhone : rawPhone?.[0]?.phoneNumber;

    return { id: body.visitor._id, name: body.visitor.name, phone };
  } catch (err) {
    console.error('[rcapi] fetchVisitorInfo error:', err);
    return null;
  }
}

export interface OpenRoomLookup {
  roomId: string;
  open: boolean;
  servedBy?: unknown;
  departmentId?: string;
  createdAt?: number;
}

// Read-only check: does this visitor currently have an open room? Deliberately
// NOT using GET /livechat/room?token=... (the endpoint openRoom() in
// visitors.ts uses to actually start/resume a chat) — that endpoint creates a
// brand new room as a side effect when the visitor has none, which is exactly
// wrong for a caller that's just polling status (self-heal, bot checks).
//
// This scans the same admin "all open rooms" listing fetchQueuedRooms()
// already uses successfully, matching by `room.v.token` client-side — an
// earlier version tried filtering server-side with `?visitorId=`, but that
// silently failed to find rooms that were genuinely open (confirmed live: a
// visitor's room stayed open in RC — reopening it via openRoom() kept
// returning the same roomId — while this check reported no open room at
// all, which broke both "you're connected" detection and status checks).
export async function fetchOpenRoomForVisitorToken(visitorToken: string): Promise<OpenRoomLookup | null> {
  const base = process.env.ROCKETCHAT_URL;
  const token = process.env.ROCKETCHAT_ADMIN_TOKEN;
  const userId = process.env.ROCKETCHAT_ADMIN_USER_ID;

  if (!base || !token || !userId) {
    console.warn('[rcapi] Missing credentials — skipping fetchOpenRoomForVisitorToken');
    return null;
  }

  let offset = 0;
  try {
    while (true) {
      const url = `${base}/api/v1/livechat/rooms?open=true&count=${PAGE_SIZE}&offset=${offset}`;
      const res = await fetch(url, {
        headers: { 'X-Auth-Token': token, 'X-User-Id': userId },
      });
      if (!res.ok) return null;

      const body = await res.json() as RocketChatRoomsResponse;
      if (!body.success || !Array.isArray(body.rooms)) return null;

      const match = body.rooms.find((room) => room.v?.token === visitorToken);
      if (match) {
        return {
          roomId: match._id,
          open: !!match.open,
          servedBy: match.servedBy,
          departmentId: match.departmentId,
          createdAt: parseRcDate(match.ts),
        };
      }

      if (offset + body.count >= body.total) break;
      offset += PAGE_SIZE;
    }
  } catch (err) {
    console.error('[rcapi] fetchOpenRoomForVisitorToken error:', err);
    return null;
  }

  return null;
}

interface RcDepartment {
  _id: string;
  name?: string;
}

interface RcDepartmentsResponse {
  departments: RcDepartment[];
  count: number;
  offset: number;
  total: number;
  success: boolean;
}

// name (lowercased) -> { id, cachedAt } — departments rarely change, so we
// avoid a round-trip to RC on every /visitors/register call.
const departmentCache = new Map<string, { id: string; cachedAt: number }>();
const DEPARTMENT_CACHE_TTL_MS = 5 * 60 * 1000;

// Resolve a department's RC id by its display name (case-insensitive), so
// callers can pass a human name (`fila`) instead of hardcoding RC's internal
// id. Paginates through every department and matches exactly — RC's `text`
// search filter isn't guaranteed to be an exact/case-insensitive match, and
// the department list is small enough that a full scan is cheap and reliable.
export async function findDepartmentIdByName(name: string): Promise<string | null> {
  const key = name.trim().toLowerCase();
  const cached = departmentCache.get(key);
  if (cached && Date.now() - cached.cachedAt < DEPARTMENT_CACHE_TTL_MS) {
    return cached.id;
  }

  const base = process.env.ROCKETCHAT_URL;
  const token = process.env.ROCKETCHAT_ADMIN_TOKEN;
  const userId = process.env.ROCKETCHAT_ADMIN_USER_ID;
  if (!base || !token || !userId) {
    console.warn('[rcapi] Missing credentials — skipping findDepartmentIdByName');
    return null;
  }

  let offset = 0;
  try {
    while (true) {
      const url = `${base}/api/v1/livechat/department?count=${PAGE_SIZE}&offset=${offset}`;
      const res = await fetch(url, {
        headers: { 'X-Auth-Token': token, 'X-User-Id': userId },
      });
      if (!res.ok) break;

      const body = await res.json() as RcDepartmentsResponse;
      if (!body.success || !Array.isArray(body.departments)) break;

      for (const dept of body.departments) {
        if (dept.name?.trim().toLowerCase() === key) {
          departmentCache.set(key, { id: dept._id, cachedAt: Date.now() });
          return dept._id;
        }
      }

      if (offset + body.count >= body.total) break;
      offset += PAGE_SIZE;
    }
  } catch (err) {
    console.error('[rcapi] findDepartmentIdByName error:', err);
  }

  return null;
}

export async function runReconciliation(): Promise<void> {
  console.log('[rcapi] starting reconciliation...');
  try {
    const { roomIds, addable } = await fetchQueuedRooms();
    queueState.reconcile(roomIds, addable);
    console.log(`[rcapi] reconciliation done — ${roomIds.size} queued rooms in RC (${addable.size} with resolvable token)`);
  } catch (err) {
    console.error('[rcapi] reconciliation error:', err);
  }
}

export function startReconciliationJob(): void {
  const intervalSecs = parseInt(process.env.RECONCILE_INTERVAL_SECONDS ?? '30', 10);
  setInterval(runReconciliation, intervalSecs * 1000);
  console.log(`[rcapi] reconciliation job started (every ${intervalSecs}s)`);
}
