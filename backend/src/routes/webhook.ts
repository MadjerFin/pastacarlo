import { Router, Request, Response } from 'express';
import { validateWebhookSecret } from '../middleware/validateWebhook';
import { queueState } from '../services/queueState';
import { parseRcDate, fetchVisitorInfo } from '../services/rocketchatApi';

const router = Router();

// Rocket.Chat sends these event types (field may be `type` or `trigger`)
type RCEventType = 'LivechatSessionStart' | 'LivechatSessionQueued' | 'LivechatSessionTaken' | 'LivechatSessionClosed' | string;

interface RCWebhookPayload {
  _id?: string;
  type?: RCEventType;
  trigger?: RCEventType;
  room?: {
    _id: string;
    departmentId?: string;
    // Pode vir como string ISO ou como Mongo extended JSON ({ $date: ... }),
    // dependendo da versão/config do RC — ver parseRcDate.
    ts?: unknown;
    [key: string]: unknown;
  };
  visitor?: {
    token: string;
    _id?: string;
    name?: string;
    [key: string]: unknown;
  };
  agent?: {
    _id?: string;
    username?: string;
    [key: string]: unknown;
  };
}

const DEFAULT_GREETING = 'Oi, sou da Sapios, como posso te ajudar?';

// Sends a standard opening message as the agent, right when a chat is taken —
// so every visitor gets a consistent first response instead of dead air
// while whoever picked up the chat gets around to typing.
async function sendGreeting(roomId: string): Promise<void> {
  const msg = process.env.LIVECHAT_GREETING_MESSAGE ?? DEFAULT_GREETING;
  if (!msg) return; // set LIVECHAT_GREETING_MESSAGE="" to disable
  const base = process.env.ROCKETCHAT_URL;
  try {
    const res = await fetch(`${base}/api/v1/chat.sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': process.env.ROCKETCHAT_ADMIN_TOKEN ?? '',
        'X-User-Id': process.env.ROCKETCHAT_ADMIN_USER_ID ?? '',
      },
      body: JSON.stringify({ message: { rid: roomId, msg } }),
    });
    const body = await res.json() as { success?: boolean; error?: string };
    if (!body.success) console.warn(`[webhook] greeting rejected for roomId=${roomId}:`, body.error);
  } catch (err) {
    console.error('[webhook] greeting error:', err);
  }
}

const DEFAULT_WELCOME_MESSAGE = 'Olá {name}! Em que posso ajudar?';

// Rooms a welcome message was already sent to — kept until the room closes,
// separate from the generic 5-min event dedup below (RC's own retry window
// is short, but we never want two welcomes in the same still-open session).
const welcomedRooms = new Set<string>();

// Sends a one-time welcome message as the agent when a livechat session
// starts. Mirrors sendGreeting's auth/fetch pattern; unlike it, interpolates
// the visitor's name into a configurable template.
async function sendWelcomeMessage(roomId: string, visitorToken: string, visitorName: string | undefined): Promise<void> {
  if (welcomedRooms.has(roomId)) return;

  const template = process.env.LIVECHAT_WELCOME_MESSAGE ?? DEFAULT_WELCOME_MESSAGE;
  if (!template) return; // set LIVECHAT_WELCOME_MESSAGE="" to disable

  const name = visitorName ?? (await fetchVisitorInfo(visitorToken))?.name ?? '';
  // Collapse the leftover space before punctuation when there's no name
  // (e.g. "Olá {name}! ..." -> "Olá! ...") instead of leaving "Olá !".
  const msg = template.replace('{name}', name).replace(/ +([!,.?])/, '$1').trim();

  const base = process.env.ROCKETCHAT_URL;
  try {
    const res = await fetch(`${base}/api/v1/chat.sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': process.env.ROCKETCHAT_ADMIN_TOKEN ?? '',
        'X-User-Id': process.env.ROCKETCHAT_ADMIN_USER_ID ?? '',
      },
      body: JSON.stringify({ message: { rid: roomId, msg } }),
    });
    const body = await res.json() as { success?: boolean; error?: string };
    if (!body.success) {
      console.warn(`[webhook] welcome message rejected for roomId=${roomId}:`, body.error);
      return;
    }
    welcomedRooms.add(roomId);
    console.log(`[webhook] welcome message sent roomId=${roomId}`);
  } catch (err) {
    console.error('[webhook] welcome message error:', err);
  }
}

// Dedup: remember recently processed event IDs to handle RC retries
const processedEvents = new Set<string>();
const EVENT_TTL_MS = 5 * 60 * 1000; // 5 minutes
function trackEvent(id: string): boolean {
  if (processedEvents.has(id)) return false; // already processed
  processedEvents.add(id);
  setTimeout(() => processedEvents.delete(id), EVENT_TTL_MS);
  return true;
}

router.post('/', validateWebhookSecret, (req: Request, res: Response) => {
  // Always respond 200 quickly so RC doesn't retry
  res.status(200).json({ ok: true });

  const payload = req.body as RCWebhookPayload;
  const eventType = payload.type ?? payload.trigger ?? 'unknown';
  // RC sends room ID at root _id, not nested under room._id
  const roomId = payload.room?._id ?? payload._id;
  const visitorToken = payload.visitor?.token;

  console.log(`[webhook] event=${eventType} roomId=${roomId} token=${visitorToken}`);

  // Dedup using roomId + eventType as a composite key (RC may not always send _id)
  const dedupKey = `${roomId}:${eventType}`;
  if (roomId && !trackEvent(dedupKey)) {
    console.log(`[webhook] duplicate event ignored: ${dedupKey}`);
    return;
  }

  if (!roomId || !visitorToken) {
    console.warn('[webhook] missing roomId or visitorToken in payload', JSON.stringify(payload));
    return;
  }

  const livechatBaseUrl = process.env.ROCKETCHAT_LIVECHAT_URL ?? `${process.env.ROCKETCHAT_URL ?? ''}/livechat`;

  switch (eventType) {
    case 'LivechatSessionStart':
      sendWelcomeMessage(roomId, visitorToken, payload.visitor?.name).catch(() => {});
      break;

    case 'LivechatSessionQueued':
    case 'Chat Queued': {
      const createdAt = parseRcDate(payload.room?.ts);
      // Empty string is its own bucket for rooms with no department set — keeps
      // position math isolated instead of crashing/comingling with real ones.
      const departmentId = payload.room?.departmentId ?? '';
      queueState.enqueue(roomId, visitorToken, departmentId, createdAt);
      break;
    }

    case 'LivechatSessionTaken':
    case 'Chat Taken': {
      // Pass only the visitor token — RC finds the open room by token automatically.
      // Adding &room= was causing "Invalid token" on the livechat page.
      const agentUrl = `${livechatBaseUrl}?token=${encodeURIComponent(visitorToken)}`;
      queueState.markConnected(roomId, visitorToken, agentUrl);
      sendGreeting(roomId).catch(() => {});
      break;
    }

    case 'LivechatSessionClosed':
    case 'Chat Closed':
      queueState.remove(roomId);
      welcomedRooms.delete(roomId);
      break;

    default:
      console.log(`[webhook] unhandled event type: ${eventType}`);
  }
});

export default router;
