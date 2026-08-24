import { Router, Request, Response } from 'express';
import { validateWebhookSecret } from '../middleware/validateWebhook';
import { queueState } from '../services/queueState';

const router = Router();

// Rocket.Chat sends these event types (field may be `type` or `trigger`)
type RCEventType = 'LivechatSessionQueued' | 'LivechatSessionTaken' | 'LivechatSessionClosed' | string;

interface RCWebhookPayload {
  _id?: string;
  type?: RCEventType;
  trigger?: RCEventType;
  room?: {
    _id: string;
    [key: string]: unknown;
  };
  visitor?: {
    token: string;
    _id?: string;
    [key: string]: unknown;
  };
  agent?: {
    _id?: string;
    username?: string;
    [key: string]: unknown;
  };
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
    case 'LivechatSessionQueued':
    case 'Chat Queued':
      queueState.enqueue(roomId, visitorToken);
      break;

    case 'LivechatSessionTaken':
    case 'Chat Taken': {
      // Pass only the visitor token — RC finds the open room by token automatically.
      // Adding &room= was causing "Invalid token" on the livechat page.
      const agentUrl = `${livechatBaseUrl}?token=${encodeURIComponent(visitorToken)}`;
      queueState.markConnected(roomId, visitorToken, agentUrl);
      break;
    }

    case 'LivechatSessionClosed':
    case 'Chat Closed':
      queueState.remove(roomId);
      break;

    default:
      console.log(`[webhook] unhandled event type: ${eventType}`);
  }
});

export default router;
