import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { findContactTokenByPhone, findDepartmentIdByName, fetchVisitorInfo } from '../services/rocketchatApi';
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

async function openRoom(visitorToken: string): Promise<string> {
  const base = process.env.ROCKETCHAT_URL;
  const url = `${base}/api/v1/livechat/room?token=${encodeURIComponent(visitorToken)}`;
  const res = await fetch(url);
  const body = await res.json() as { room?: { _id?: string }; success?: boolean; error?: string };
  console.log(`[visitors] openRoom raw:`, JSON.stringify(body).slice(0, 200));
  return body.room?._id ?? '';
}

// POST /visitors/register  body: { name, phone, fila? }
// `fila` é o nome do departamento como cadastrado na RC (ex: "Suporte") —
// resolvido dinamicamente pra um ID via findDepartmentIdByName, então não
// precisa hardcodear/expor o ID interno da RC. Omitido, cai no departamento
// padrão (mantém os links antigos, sem esse parâmetro, funcionando).
// Protegido por secret (Authorization: Bearer) — só o bot pode chamar. Sem
// isso, qualquer um que soubesse um telefone alheio reabriria a conversa
// daquela pessoa (histórico + capacidade de mandar mensagem em nome dela).
router.post('/register', requireBotSecret, async (req: Request, res: Response) => {
  const { name, phone, fila } = req.body as { name?: string; phone?: string; fila?: string };

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
    const roomId = await openRoom(confirmedToken);
    console.log(`[visitors] room opened roomId=${roomId} token=${confirmedToken.slice(0, 12)}...`);

    const link = buildAppLink(confirmedToken, roomId || undefined, name, cleanPhone);
    res.json({ ok: true, token: confirmedToken, roomId, link });
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

    const roomId = await openRoom(token);
    console.log(`[visitors] reopened roomId=${roomId} token=${token.slice(0, 12)}...`);

    const link = buildAppLink(token, roomId || undefined, info.name, info.phone);
    res.json({ ok: true, token, roomId, link });
  } catch (err) {
    console.error('[visitors] reopen error:', err);
    res.status(500).json({ ok: false, error: 'Erro ao reabrir atendimento' });
  }
});

export default router;
