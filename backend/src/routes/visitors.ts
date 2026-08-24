import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';

const router = Router();

const SAPIOS_DEPT_ID = '69316b35a79d2ae8ad44383f';

function rcHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Auth-Token': process.env.ROCKETCHAT_ADMIN_TOKEN ?? '',
    'X-User-Id': process.env.ROCKETCHAT_ADMIN_USER_ID ?? '',
  };
}

async function findContactByPhone(phone: string): Promise<string | null> {
  const base = process.env.ROCKETCHAT_URL;
  const res = await fetch(
    `${base}/api/v1/omnichannel/contact.search?phone=${encodeURIComponent(phone)}`,
    { headers: rcHeaders() },
  );
  if (!res.ok) return null;
  const body = await res.json() as { contact?: { token?: string } };
  const token = body.contact?.token ?? null;
  // Ignore tokens we generated ourselves (base64url of 'sapios:phone') — they're
  // rejected by the RC livechat page. Let RC generate a fresh one instead.
  if (token?.startsWith('c2FwaW9z')) {
    console.log(`[visitors] ignoring legacy custom token, will request fresh RC token`);
    return null;
  }
  return token;
}

async function registerVisitor(name: string, phone: string, token: string): Promise<string> {
  const base = process.env.ROCKETCHAT_URL;
  const res = await fetch(`${base}/api/v1/livechat/visitor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      visitor: {
        name,
        token,
        phone, // native field — required for omnichannel/contact.search to find this visitor later
        department: SAPIOS_DEPT_ID,
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

// POST /visitors/register
router.post('/register', async (req: Request, res: Response) => {
  const { name, phone } = req.body as { name?: string; phone?: string };

  if (!name || !phone) {
    res.status(400).json({ ok: false, error: 'name e phone são obrigatórios' });
    return;
  }

  const cleanPhone = phone.replace(/\D/g, '');
  console.log(`[visitors] registering name="${name}" phone="${cleanPhone}"`);

  try {
    // 1. Check if visitor already exists in RC by phone (returns their RC-generated token)
    const existingToken = await findContactByPhone(cleanPhone);

    // Use existing RC token or generate a random hex one (same format RC uses internally)
    const tokenToUse = existingToken ?? randomBytes(17).toString('hex');
    console.log(`[visitors] ${existingToken ? 'existing' : 'new'} visitor token=${tokenToUse.slice(0, 12)}...`);

    // 2. Register/update visitor in RC (idempotent — RC upserts by token)
    const confirmedToken = await registerVisitor(name, cleanPhone, tokenToUse);

    // 4. Open (or reopen) the livechat room in Sapios dept
    const roomId = await openRoom(confirmedToken);
    console.log(`[visitors] room opened roomId=${roomId} token=${confirmedToken.slice(0, 12)}...`);

    res.json({ ok: true, token: confirmedToken, roomId });
  } catch (err) {
    console.error('[visitors] register error:', err);
    res.status(500).json({ ok: false, error: 'Erro ao registrar visitante' });
  }
});

export default router;
