import { Router, Request, Response } from 'express';
import { validateWebhookSecret } from '../middleware/validateWebhook';
import { queueState } from '../services/queueState';
import { parseRcDate, fetchVisitorInfo } from '../services/rocketchatApi';

const router = Router();

// Rocket.Chat sends these event types (field may be `type` or `trigger`)
type RCEventType =
  | 'LivechatSessionStart'
  | 'LivechatSessionQueued'
  | 'LivechatSessionTaken'
  | 'LivechatSessionClosed'
  | string;

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
    name?: string;
    [key: string]: unknown;
  };
}

const DEFAULT_GREETING = 'Olá {name}! Sou {agent}, da Sapios. Como posso te ajudar?';

// Rooms a greeting was already sent to — kept until the room closes, separate
// from the generic 5-min event dedup below (RC's own retry window is short,
// but we never want two greetings in the same still-open session, e.g. when
// a chat is transferred and "taken" again by another agent).
const greetedRooms = new Set<string>();

function rcAdminHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Auth-Token': process.env.ROCKETCHAT_ADMIN_TOKEN ?? '',
    'X-User-Id': process.env.ROCKETCHAT_ADMIN_USER_ID ?? '',
  };
}

// The webhook's `agent` doesn't always carry a display name — fall back to
// users.info, then to the username.
async function resolveAgentName(agent: RCWebhookPayload['agent']): Promise<string | undefined> {
  if (agent?.name) return agent.name as string;
  if (agent?._id) {
    try {
      const res = await fetch(`${process.env.ROCKETCHAT_URL}/api/v1/users.info?userId=${encodeURIComponent(agent._id)}`, {
        headers: rcAdminHeaders(),
      });
      const body = await res.json() as { user?: { name?: string } };
      if (body.user?.name) return body.user.name;
    } catch (err) {
      console.error('[webhook] users.info error:', err);
    }
  }
  return agent?.username;
}

// Sends the opening message right when a chat is taken, shown as the agent
// who took it (name + avatar) instead of the admin account. There's no REST
// way to post as another user without their credentials, so this posts with
// the admin token plus `alias`/`avatar` — requires the admin's role to have
// the "message-impersonate" permission in RC. Without it RC rejects the
// message and nothing is sent (never falls back to posting as the admin).
async function sendAgentGreeting(
  roomId: string,
  visitorToken: string,
  visitorName: string | undefined,
  agent: RCWebhookPayload['agent'],
): Promise<void> {
  if (greetedRooms.has(roomId)) return;

  const template = process.env.LIVECHAT_GREETING_MESSAGE ?? DEFAULT_GREETING;
  if (!template) return; // set LIVECHAT_GREETING_MESSAGE="" to disable

  const [name, agentName] = await Promise.all([
    visitorName ?? fetchVisitorInfo(visitorToken).then(v => v?.name),
    resolveAgentName(agent),
  ]);
  // Collapse the leftover space before punctuation when a placeholder is
  // empty (e.g. "Olá {name}! ..." -> "Olá! ...") instead of leaving "Olá !".
  const msg = template
    .replace('{name}', name ?? '')
    .replace('{agent}', agentName ?? '')
    .replace(/ +([!,.?])/g, '$1')
    .trim();

  const base = process.env.ROCKETCHAT_URL;
  const message: Record<string, string> = { rid: roomId, msg };
  if (agentName) message.alias = agentName;
  if (agent?.username) message.avatar = `${base}/avatar/${encodeURIComponent(agent.username)}`;

  try {
    const res = await fetch(`${base}/api/v1/chat.sendMessage`, {
      method: 'POST',
      headers: rcAdminHeaders(),
      body: JSON.stringify({ message }),
    });
    const body = await res.json() as { success?: boolean; error?: string; errorType?: string };
    if (!body.success) {
      console.warn(`[webhook] greeting rejected for roomId=${roomId}: ${body.errorType ?? ''} ${body.error ?? ''}` +
        ' — se for "not allowed", dê a permissão "message-impersonate" ao papel do usuário admin na RC');
      return;
    }
    greetedRooms.add(roomId);
    console.log(`[webhook] greeting sent roomId=${roomId} as="${agentName ?? '?'}"`);
  } catch (err) {
    console.error('[webhook] greeting error:', err);
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
      // No message here anymore — the greeting goes out on Taken, as the agent
      // who picked up the chat, instead of as the admin before anyone's there.
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
      // Fires only once RC's routing has assigned a genuinely online,
      // available agent — trustworthy now that the webhook is authenticated
      // (validateWebhookSecret) so this event can't be forged.
      // Pass only the visitor token — RC finds the open room by token automatically.
      // Adding &room= was causing "Invalid token" on the livechat page.
      const agentUrl = `${livechatBaseUrl}?token=${encodeURIComponent(visitorToken)}`;
      queueState.confirmHumanAgent(roomId, visitorToken, agentUrl);
      sendAgentGreeting(roomId, visitorToken, payload.visitor?.name, payload.agent).catch(() => {});
      break;
    }

    // Confirmed from live traffic: RC's "Send Request on Chat Closed" trigger
    // actually sends `type: "LivechatSession"` (the full transcript, per RC's
    // docs) — not "LivechatSessionClosed"/"Chat Closed" as previously assumed.
    // Without this case, closed rooms stayed "connected" locally until the
    // next periodic reconciliation (up to RECONCILE_INTERVAL_SECONDS later)
    // caught the mismatch, so an immediate status check right after closing
    // still reported "connected". Keeping the old names too in case a
    // different RC version/config sends them.
    case 'LivechatSession':
    case 'LivechatSessionClosed':
    case 'Chat Closed':
      queueState.remove(roomId);
      greetedRooms.delete(roomId);
      break;

    default:
      console.log(`[webhook] unhandled event type: ${eventType}`);
  }
});

export default router;
