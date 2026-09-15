import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

// RC's Omnichannel webhook does NOT sign the payload (no HMAC) — it just
// echoes the configured "Secret Token" back verbatim in this header on every
// request, so validation is a plain shared-secret comparison. See:
// https://github.com/RocketChat/docs/blob/main/use-rocket.chat/omnichannel/webhooks.md
const SECRET_HEADER = 'x-rocketchat-livechat-token';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch — compare lengths first, but a
  // plain length check isn't itself timing-sensitive (secret length isn't
  // confidential the way its content is).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function validateWebhookSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.LIVECHAT_WEBHOOK_SECRET;

  // Fail CLOSED: with no secret configured there is no valid signature any
  // request could present, so every request is rejected — not accepted.
  // Previously this fell through to `next()`, which meant an attacker who
  // simply knew the endpoint URL could forge any Livechat event (including
  // fake "agent connected" events) whenever an operator forgot to set this.
  if (!secret) {
    console.error(
      '[webhook] LIVECHAT_WEBHOOK_SECRET not set — rejecting all requests. ' +
        'Configure the same secret in Admin > Omnichannel > Webhooks and in this env var.',
    );
    res.status(401).json({ ok: false, error: 'webhook_not_configured' });
    return;
  }

  const incoming = req.headers[SECRET_HEADER];
  if (typeof incoming !== 'string' || !safeCompare(incoming, secret)) {
    // Don't log the incoming value — it's either garbage or someone's guess
    // at the real secret, neither of which belongs in logs.
    console.warn('[webhook] rejected request: missing or invalid X-Rocketchat-Livechat-Token header');
    res.status(401).json({ ok: false, error: 'invalid_token' });
    return;
  }

  next();
}
