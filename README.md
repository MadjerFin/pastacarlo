# Pastacarlo — Sala de espera para Rocket.Chat Omnichannel

Interface de fila de atendimento que exibe a posição do visitante em tempo real e o redireciona automaticamente quando um agente assume a conversa.

---

## Estrutura

```
pastacarlo/
├── backend/          # Node.js + Express + TypeScript
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/
│   │   │   ├── webhook.ts        # POST /webhooks/rocketchat
│   │   │   └── queue.ts          # GET /queue/:token  e  GET /queue/stream/:token
│   │   ├── services/
│   │   │   ├── queueState.ts     # Estado em memória + SSE
│   │   │   └── rocketchatApi.ts  # Reconciliação com a API REST do RC
│   │   └── middleware/
│   │       └── validateWebhook.ts
│   └── .env.example
└── frontend/         # React + Vite + TypeScript
    ├── src/
    │   ├── App.tsx
    │   ├── components/WaitingRoom.tsx
    │   └── index.css
    └── .env.example
```

---

## Pré-requisitos

- Node.js 18+
- Uma instância do Rocket.Chat com Omnichannel habilitado
- Permissão de admin/manager para configurar webhooks e consultar a API

---

## Configuração rápida

### 1. Clone e instale dependências

```bash
# backend
cd backend
cp .env.example .env
npm install

# frontend
cd ../frontend
cp .env.example .env
npm install
```

### 2. Preencha o `.env` do backend

| Variável | Descrição |
|---|---|
| `ROCKETCHAT_URL` | URL da instância, ex: `https://chat.empresa.com` |
| `ROCKETCHAT_ADMIN_TOKEN` | X-Auth-Token de um usuário admin/manager |
| `ROCKETCHAT_ADMIN_USER_ID` | X-User-Id do mesmo usuário |
| `LIVECHAT_WEBHOOK_SECRET` | Secret token que você vai configurar no RC |
| `PORT` | Porta do backend (padrão: 3000) |
| `RECONCILE_INTERVAL_SECONDS` | Intervalo de reconciliação com a API do RC (padrão: 30) |
| `FRONTEND_URL` | URL do frontend para CORS (padrão: `http://localhost:5173`) |
| `ROCKETCHAT_LIVECHAT_URL` | URL do widget de livechat onde o visitante será redirecionado |

### 3. Rode em desenvolvimento

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
cd frontend && npm run dev
```

Acesse `http://localhost:5173/?token=SEU_VISITOR_TOKEN`

---

## Configurar o Webhook no Rocket.Chat

1. Acesse **Admin → Omnichannel → Webhooks**
2. Clique em **New Webhook**
3. Preencha:
   - **Webhook URL**: `https://seu-backend.exemplo.com/webhooks/rocketchat`
   - **Secret Token**: o mesmo valor de `LIVECHAT_WEBHOOK_SECRET` no `.env`
4. Habilite os eventos:
   - ✅ **Chat Queued**
   - ✅ **Chat Taken**
   - ✅ **Chat Closed**
5. Salve e teste com o botão **Send Test**

> O Rocket.Chat reenvia o webhook até 10 vezes (intervalo de 10s) caso não receba HTTP 200.
> O backend responde 200 imediatamente e processa de forma idempotente.

---

## Como funciona o fluxo

```
Visitante inicia chat
       │
       ▼
RC coloca na fila  ──POST /webhooks/rocketchat──►  backend registra na fila
       │
       ▼
Visitante acessa   ──GET /queue/stream/:token──►  SSE aberto, recebe posição
a sala de espera
       │
       ▼
Agente assume    ──POST /webhooks/rocketchat──►  backend emite evento "connected"
       │
       ▼
Frontend recebe "connected"  ──►  redireciona para URL do livechat
```

---

## Endpoints do backend

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/webhooks/rocketchat` | Recebe eventos do Omnichannel |
| GET | `/queue/:visitorToken` | Snapshot do status atual |
| GET | `/queue/room/:roomId` | Posição na fila, status (`queued`/`connected`/`closed`) e `agentUrl` quando conectado, por roomId (consumido pelo bot, rate limit 20 req/min por IP) |
| POST | `/queue/phone` `{ phone }` | Idem, mas resolvendo o visitante pelo telefone. É POST (telefone no body, não na URL) para não deixar o número em logs de acesso/proxies; rate limit 20 req/min por IP |
| GET | `/queue/stream/:visitorToken` | SSE com atualizações em tempo real |
| GET | `/health` | Health check |

### Eventos SSE emitidos

| Evento | Payload | Quando |
|--------|---------|--------|
| `queue_update` | `{ position, queueSize, estimatedWaitSeconds }` | Posição muda |
| `connected` | `{ agentUrl }` | Agente assumiu o chat |
| `waiting` | `{ message }` | Token ainda não registrado |
| `: heartbeat` | — | A cada 25s (keepalive) |

---

## Deploy em produção

O backend serve os arquivos estáticos do frontend (`frontend/dist`) diretamente — então dá pra rodar **os dois em um único serviço**, sem CORS e sem precisar de tunnel.

### Deploy no Render (um único Web Service)

1. Suba o repositório (backend + frontend) num repo Git (GitHub/GitLab) — o Render faz deploy a partir dele.
2. No Render, crie um **Web Service** apontando pro repo, com:
   - **Root Directory**: raiz do repo (deixe em branco)
   - **Build Command**:
     ```bash
     cd frontend && npm install && npm run build && cd ../backend && npm install && npm run build
     ```
   - **Start Command**:
     ```bash
     cd backend && npm start
     ```
   - **Environment**: Node
3. Configure as variáveis de ambiente do backend (aba *Environment* do Render, mesmos valores do `backend/.env`):
   `ROCKETCHAT_URL`, `ROCKETCHAT_ADMIN_TOKEN`, `ROCKETCHAT_ADMIN_USER_ID`, `LIVECHAT_WEBHOOK_SECRET`, `RECONCILE_INTERVAL_SECONDS`, `ROCKETCHAT_LIVECHAT_URL`.
   Não defina `PORT` — o Render injeta a própria porta automaticamente e o app já respeita `process.env.PORT`.
4. Depois do primeiro deploy, você terá uma URL pública (ex: `https://pastacarlo.onrender.com`). Ajuste:
   - `FRONTEND_URL` no ambiente do Render para essa mesma URL (CORS deixa de ser um problema por serem mesma origem, mas mantenha por consistência).
   - O webhook no Rocket.Chat (Admin → Omnichannel → Webhooks) para `https://pastacarlo.onrender.com/webhooks/rocketchat`.
5. Acesse `https://pastacarlo.onrender.com/entrar?nome=X&tel=Y` — funciona de qualquer computador, sem tunnel.

### Escala

- Para escalar horizontalmente, substitua o `Map` em memória por Redis (Pub/Sub para SSE + Hash para estado)
