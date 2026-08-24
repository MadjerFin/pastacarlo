import { Request, Response, NextFunction } from 'express';

export function validateWebhookSecret(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.LIVECHAT_WEBHOOK_SECRET;

  // If no secret is configured, skip validation (useful for local dev without RC)
  if (!secret) {
    console.warn('[webhook] LIVECHAT_WEBHOOK_SECRET not set — skipping token validation');
    next();
    return;
  }

  const incoming = req.headers['x-rocketchat-livechat-token'];
  if (!incoming || incoming !== secret) {
    console.warn(`[webhook] Invalid secret token. Got: "${incoming}"`);
    // Still respond 200 so Rocket.Chat stops retrying, but log the rejection
    res.status(200).json({ ok: false, error: 'invalid_token' });
    return;
  }

  next();
}
