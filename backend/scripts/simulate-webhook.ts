// Simula o cenário do bug original contra um backend rodando localmente:
// Rocket.Chat atribui a sala (LivechatSessionTaken) sem nenhum humano
// realmente presente, e confirma que a fila NÃO reporta "connected" até
// chegar uma mensagem real de agente.
//
// Uso:
//   BASE_URL=http://localhost:3000 LIVECHAT_WEBHOOK_SECRET=xxx tsx scripts/simulate-webhook.ts
//
// (LIVECHAT_WEBHOOK_SECRET deve ser o mesmo valor configurado no backend.)

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const SECRET = process.env.LIVECHAT_WEBHOOK_SECRET;

if (!SECRET) {
  console.error('Defina LIVECHAT_WEBHOOK_SECRET (mesmo valor do backend) antes de rodar este script.');
  process.exit(1);
}

const roomId = `sim-room-${Date.now()}`;
const visitorToken = `sim-token-${Date.now()}`;
const fakeAgentId = 'sim-agent-id';

async function postWebhook(payload: unknown): Promise<void> {
  const res = await fetch(`${BASE_URL}/webhooks/rocketchat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Rocketchat-Livechat-Token': SECRET as string,
    },
    body: JSON.stringify(payload),
  });
  console.log(`  -> POST /webhooks/rocketchat: ${res.status}`);
}

async function getQueueStatus(): Promise<string> {
  const res = await fetch(`${BASE_URL}/queue/${visitorToken}`);
  if (res.status === 404) return 'not_found';
  const body = (await res.json()) as { status?: string };
  return body.status ?? 'unknown';
}

async function main() {
  console.log(`\n[1] Enfileirando visitante (roomId=${roomId})`);
  await postWebhook({
    type: 'LivechatSessionQueued',
    room: { _id: roomId, departmentId: 'sim-dept', ts: new Date().toISOString() },
    visitor: { token: visitorToken },
  });
  console.log(`    status atual: ${await getQueueStatus()} (esperado: queued)`);

  console.log(`\n[2] Disparando LivechatSessionTaken SEM humano real (roteamento automático)`);
  await postWebhook({
    type: 'LivechatSessionTaken',
    room: { _id: roomId },
    visitor: { token: visitorToken },
    agent: { _id: fakeAgentId, username: 'auto-routing-agent' },
  });
  const statusAfterTaken = await getQueueStatus();
  console.log(`    status atual: ${statusAfterTaken} (esperado: queued — NÃO deve virar 'connected' só com o Taken)`);
  if (statusAfterTaken === 'connected') {
    console.error('    FALHA: fila marcou "connected" sem confirmação de agente humano.');
    process.exitCode = 1;
  } else {
    console.log('    OK: frontend continuaria mostrando "aguardando", não "conectado".');
  }

  console.log(`\n[3] Disparando mensagem real do agente humano (evento 'Message')`);
  await postWebhook({
    type: 'Message',
    room: { _id: roomId },
    visitor: { token: visitorToken },
    agent: { _id: fakeAgentId, username: 'agente-real' },
    messages: [{ _id: 'msg1', msg: 'Oi, tudo bem?', agentId: fakeAgentId, u: { _id: fakeAgentId, username: 'agente-real' } }],
  });
  const statusAfterMessage = await getQueueStatus();
  console.log(`    status atual: ${statusAfterMessage} (esperado: connected)`);
  if (statusAfterMessage !== 'connected') {
    console.error('    FALHA: mensagem real do agente não confirmou o status "connected".');
    process.exitCode = 1;
  } else {
    console.log('    OK: só agora o frontend mostraria "conectado".');
  }

  console.log(`\n[4] Encerrando sala simulada`);
  await postWebhook({ type: 'LivechatSessionClosed', room: { _id: roomId }, visitor: { token: visitorToken } });

  console.log(process.exitCode ? '\nResultado: FALHOU\n' : '\nResultado: OK\n');
}

main().catch((err) => {
  console.error('Erro ao rodar simulação:', err);
  process.exit(1);
});
