import rateLimit from 'express-rate-limit';

// Defense-in-depth on top of validateBotSecret: even with a valid (or leaked)
// secret, caps how many phone numbers can be probed per minute — /queue/phone
// is the sensitive one since phone numbers are guessable/enumerable, unlike
// roomId which is an opaque RC-generated id.
export const botRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'rate_limited' },
});
