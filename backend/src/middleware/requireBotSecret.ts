import { Request, Response, NextFunction } from 'express';

// Protects POST /visitors/register specifically: unlike the read-only status
// endpoints (/queue/phone, /queue/room), this one grants real access — for a
// known phone it resumes the visitor's EXISTING token/room, meaning whoever
// calls it can read that visitor's chat history and send messages as them.
// Without this, anyone who knows (or guesses) someone else's phone number
// could hijack their conversation just by hitting this endpoint directly, or
// via the old /entrar?nome=X&tel=Y browser page. Only the bot (which holds
// this secret server-side) may call it now — via `Authorization: Bearer <secret>`.
export function requireBotSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.BOT_API_SECRET;

  if (!secret) {
    console.warn('[visitors] BOT_API_SECRET not set — skipping token validation (dev only)');
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const incoming = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
  if (!incoming || incoming !== secret) {
    console.warn(`[visitors] Invalid or missing Authorization: Bearer on ${req.method} ${req.path}`);
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  next();
}
