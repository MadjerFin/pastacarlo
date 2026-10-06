import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { findContactTokenByPhone, findDepartmentIdByName, fetchVisitorInfo, fetchAgentsOnline } from '../services/rocketchatApi';
import { buildAppLink } from '../services/links';
import { requireBotSecret } from '../middleware/requireBotSecret';

const router = Router();

// Fallback quando a requisição não informa `fila` — mantém os links antigos
// (sem esse parâmetro) funcionando como antes.
const DEFAULT_DEPARTMENT_ID = '69316b35a79d2ae8ad44383f';

async function registerVisitor(name: string | undefined, phone: string, token: string, departmentId: string): Promise<string> {
  const base = process.env.ROCKETCHAT_URL;
  const res = await fetch(`${base}/api/v1/livechat/visitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visitor: {
        // The latest name always overwrites the one on file — safe now that
        // this route requires the bot's secret (only the bot decides what
        // name to send, taken fresh from the current conversation).
        ...(name ? { name } : {}),
        token,
        phone, // native field — required for omnichannel/contact.search to find this visitor later
        department: departmentId,
        customFields: [{ key: 'phone', value: phone, overwrite: true }],
      },
    }),
  });
  const body = await res.json() as { visitor?: { token?: string }; token?: string; success?: boolean; error?: string };
  console.log(`[visitors] registerVisitor raw:`, JSON.stringify(body).slice(0, 200));
  const returned = body.visitor?.token ?? body.token;
  if (!returned) throw new Error(`registerVisitor failed: ${JSON.stringify(body)}`);
  return returned;
}

async function openRoom(visitorToken: string): Promise<{ roomId: string; newRoom: boolean; errorType?: string }> {
  const base = process.env.ROCKETCHAT_URL;
  const url = `${base}/api/v1/livechat/room?token=${encodeURIComponent(visitorToken)}`;
  const res = await fetch(url);
  const body = await res.json() as { room?: { _id?: string }; newRoom?: boolean; success?: boolean; error?: string; errorType?: string };
  console.log(`[visitors] openRoom raw:`, JSON.stringify(body).slice(0, 200));
  // RC sends `newRoom: false` when it resumed an already-open room. Treat a
  // missing flag as new, so older RC versions still get the infoagent message.
  return { roomId: body.room?._id ?? '', newRoom: body.newRoom !== false, errorType: body.errorType };
}

const INFOAGENT_MAX_LENGTH = 4000;

// The bot can send `infoagent` as plain text or as an object of fields
// (e.g. { cpf: "...", plano: "..." }) — objects become one "chave: valor"
// line each, so the agent reads it as a tidy summary instead of raw JSON.
function formatInfoAgent(info: unknown): string {
  if (info == null) return '';
  if (typeof info === 'string') return info.trim().slice(0, INFOAGENT_MAX_LENGTH);
  if (typeof info === 'object' && !Array.isArray(info)) {
    return Object.entries(info as Record<string, unknown>)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join('\n')
      .slice(0, INFOAGENT_MAX_LENGTH);
  }
  return String(info).slice(0, INFOAGENT_MAX_LENGTH);
}

// Posts the bot's collected data as the visitor's first message in the room,
// so whoever takes the chat already knows who they're talking to. Sent as the
// visitor (livechat/message, same as /chat/message) rather than as an agent,
// so it doesn't count as an agent reply. Never fails the registration.
async function sendInfoAgent(visitorToken: string, roomId: string, msg: string): Promise<void> {
  const base = process.env.ROCKETCHAT_URL;
  try {
    const res = await fetch(`${base}/api/v1/livechat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: visitorToken, rid: roomId, msg }),
    });
    const body = await res.json() as { success?: boolean; error?: string };
    if (!body.success) console.warn(`[visitors] infoagent rejected for roomId=${roomId}:`, body.error);
    else console.log(`[visitors] infoagent sent roomId=${roomId}`);
  } catch (err) {
    console.error('[visitors] infoagent error:', err);
  }
}

// POST /visitors/register  body: { name, phone, fila?, infoagent? }
// `infoagent` (texto ou objeto { campo: valor }) é postado como a primeira
// mensagem do visitante na sala — só quando a sala é nova, pra não repetir
// os dados se o bot chamar de novo com a sala ainda aberta.
// `fila` é o nome do departamento como cadastrado na RC (ex: "Suporte") —
// resolvido dinamicamente pra um ID via findDepartmentIdByName, então não
// precisa hardcodear/expor o ID interno da RC. Omitido, cai no departamento
// padrão (mantém os links antigos, sem esse parâmetro, funcionando).
// Protegido por secret (Authorization: Bearer) — só o bot pode chamar. Sem
// isso, qualquer um que soubesse um telefone alheio reabriria a conversa
// daquela pessoa (histórico + capacidade de mandar mensagem em nome dela).
router.post('/register', requireBotSecret, async (req: Request, res: Response) => {
  const { name, phone, fila, infoagent } = req.body as { name?: string; phone?: string; fila?: string; infoagent?: unknown };

  if (!name || !phone) {
    res.status(400).json({ ok: false, error: 'name e phone são obrigatórios' });
    return;
  }

  const cleanPhone = phone.replace(/\D/g, '');
  console.log(`[visitors] registering name="${name}" phone="${cleanPhone}" fila="${fila ?? '(padrão)'}"`);

  let departmentId = DEFAULT_DEPARTMENT_ID;
  if (fila) {
    const resolved = await findDepartmentIdByName(fila);
    if (!resolved) {
      res.status(400).json({ ok: false, error: 'department_not_found' });
      return;
    }
    departmentId = resolved;
  }

  try {
    // 1. Check if visitor already exists in RC by phone (returns their RC-generated token)
    const existingToken = await findContactTokenByPhone(cleanPhone);

    // Use existing RC token or generate a random hex one (same format RC uses internally)
    const tokenToUse = existingToken ?? randomBytes(17).toString('hex');
    console.log(`[visitors] ${existingToken ? 'existing' : 'new'} visitor token=${tokenToUse.slice(0, 12)}...`);

    // 2. Register/update visitor in RC (idempotent — RC upserts by token).
    // Always sends the name, so it overwrites whatever RC had on file —
    // the visitor's most recent entry wins.
    const confirmedToken = await registerVisitor(name, cleanPhone, tokenToUse, departmentId);

    // 4. Open (or reopen) the livechat room in the resolved department
    const { roomId, newRoom, errorType } = await openRoom(confirmedToken);

    // RC refuses to create a room when no agent is online (unless it's set to
    // accept chats without agents). Answer that explicitly instead of a
    // success without a room — that sent the visitor to a page with nothing
    // to wait on, whose "Iniciar novo atendimento" just looped.
    if (!roomId && errorType === 'no-agent-online') {
      console.log(`[visitors] no agent online — room not opened token=${confirmedToken.slice(0, 12)}...`);
      res.status(503).json({ ok: false, error: 'no_agent_online', agentsOnline: false });
      return;
    }
    console.log(`[visitors] room opened roomId=${roomId} new=${newRoom} token=${confirmedToken.slice(0, 12)}...`);

    // 5. Post the bot's collected data as the visitor's first message
    const infoMsg = formatInfoAgent(infoagent);
    if (infoMsg && roomId && newRoom) {
      await sendInfoAgent(confirmedToken, roomId, infoMsg);
    }

    // Lets the bot warn the visitor on WhatsApp too ("no momento não há
    // atendentes online") — null when RC's status couldn't be read.
    const agentsOnline = await fetchAgentsOnline(departmentId);

    const link = buildAppLink(confirmedToken, roomId || undefined, name, cleanPhone);
    res.json({ ok: true, token: confirmedToken, roomId, link, agentsOnline });
  } catch (err) {
    console.error('[visitors] register error:', err);
    res.status(500).json({ ok: false, error: 'Erro ao registrar visitante' });
  }
});

// POST /visitors/reopen  body: { token }
// Lets a visitor who's still sitting on their own chat page (or bookmarked
// its link) start a new room after theirs closed — without the bot's
// secret. Safe without one: `token` is a long random RC-issued value, not a
// guessable phone number, so possessing it already proves you're that
// visitor. Never looks anyone up by phone/name — that's the whole point.
router.post('/reopen', async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token) {
    res.status(400).json({ ok: false, error: 'token é obrigatório' });
    return;
  }

  try {
    const info = await fetchVisitorInfo(token);
    if (!info) {
      res.status(404).json({ ok: false, error: 'visitor_not_found' });
      return;
    }

    const { roomId, errorType } = await openRoom(token);
    if (!roomId && errorType === 'no-agent-online') {
      console.log(`[visitors] no agent online — room not reopened token=${token.slice(0, 12)}...`);
      res.status(503).json({ ok: false, error: 'no_agent_online' });
      return;
    }
    console.log(`[visitors] reopened roomId=${roomId} token=${token.slice(0, 12)}...`);

    const link = buildAppLink(token, roomId || undefined, info.name, info.phone);
    res.json({ ok: true, token, roomId, link });
  } catch (err) {
    console.error('[visitors] reopen error:', err);
    res.status(500).json({ ok: false, error: 'Erro ao reabrir atendimento' });
  }
});

export default router;
