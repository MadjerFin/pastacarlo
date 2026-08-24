import 'dotenv/config';
import path from 'path';
import express from 'express';
import webhookRouter from './routes/webhook';
import queueRouter from './routes/queue';
import visitorsRouter from './routes/visitors';
import chatRouter from './routes/chat';
import { startReconciliationJob } from './services/rocketchatApi';
import { queueState } from './services/queueState';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_URL);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-RocketChat-Livechat-Token');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json());

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhooks/rocketchat', webhookRouter);
app.use('/queue', queueRouter);
app.use('/visitors', visitorsRouter);
app.use('/chat', chatRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Debug: manually fire the "connected" event for a visitor (dev only)
app.post('/debug/connect/:token', (req, res) => {
  const { token } = req.params;
  const { roomId } = req.body as { roomId?: string };
  if (!roomId) { res.status(400).json({ ok: false, error: 'roomId required' }); return; }
  const agentUrl = '';
  queueState.markConnected(roomId, token, agentUrl);
  console.log(`[debug] manually triggered connected for token=${token} roomId=${roomId}`);
  res.json({ ok: true });
});

// ── Frontend estático (build único: backend serve o frontend/dist) ─────────────
const FRONTEND_DIST = path.join(__dirname, '../../frontend/dist');
app.use(express.static(FRONTEND_DIST));
app.get('*', (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/webhooks') || req.path.startsWith('/queue')
    || req.path.startsWith('/visitors') || req.path.startsWith('/chat')
    || req.path.startsWith('/health') || req.path.startsWith('/debug')) {
    next();
    return;
  }
  res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  startReconciliationJob();
});
