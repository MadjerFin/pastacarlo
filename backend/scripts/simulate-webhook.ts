// Simula o cenário do bug original contra um backend rodando localmente (ou
// no Render): o problema real não era o Rocket.Chat disparar
// LivechatSessionTaken sem humano (o roteamento deles só atribui agentes
// online/disponíveis) — era o endpoint aceitar QUALQUER payload, inclusive
// forjado por quem soubesse a URL, porque a validação de assinatura era
// pulada quando LIVECHAT_WEBHOOK_SECRET não estava setado.
//
// Este script confirma: (1) um evento sem o secret correto é rejeitado (401)
// e não altera o estado da fila; (2) um LivechatSessionTaken autenticado
// continua conectando o visitante imediatamente, como antes.
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

async function postWebhook(payload: unknown, secret: string): Promise<number> {
  const res = await fetch(`${BASE_URL}/webhooks/rocketchat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Rocketchat-Livechat-Token': secret,
    },
    body: JSON.stringify(payload),
  });
  console.log(`  -> POST /webhooks/rocketchat: ${res.status}`);
  return res.status;
}

async function getQueueStatus(): Promise<string> {
  const res = await fetch(`${BASE_URL}/queue/${visitorToken}`);
  if (res.status === 404) return 'not_found';
  const body = (await res.json()) as { status?: string };
  return body.status ?? 'unknown';
}

async function main() {
  console.log(`\n[1] Tentando forjar um LivechatSessionTaken com secret ERRADO (roomId=${roomId})`);
  const forgedStatus = await postWebhook(
    {
      type: 'LivechatSessionTaken',
      room: { _id: roomId },
      visitor: { token: visitorToken },
      agent: { _id: fakeAgentId, username: 'forjado' },
    },
    'secret-errado-de-proposito',
  );
  if (forgedStatus === 200) {
    console.error('    FALHA: requisição forjada foi aceita (esperado 401).');
    process.exitCode = 1;
  } else {
    console.log(`    OK: requisição forjada rejeitada (status ${forgedStatus}).`);
  }
  const statusAfterForged = await getQueueStatus();
  if (statusAfterForged !== 'not_found') {
    console.error(`    FALHA: estado da fila mudou mesmo com requisição forjada (status=${statusAfterForged}).`);
    process.exitCode = 1;
  } else {
    console.log('    OK: nenhum estado de fila foi criado a partir do evento forjado.');
  }

  console.log(`\n[2] Enfileirando visitante com secret correto`);
  await postWebhook(
    {
      type: 'LivechatSessionQueued',
      room: { _id: roomId, departmentId: 'sim-dept', ts: new Date().toISOString() },
      visitor: { token: visitorToken },
    },
    SECRET as string,
  );
  console.log(`    status atual: ${await getQueueStatus()} (esperado: queued)`);

  console.log(`\n[3] Disparando LivechatSessionTaken autenticado`);
  await postWebhook(
    {
      type: 'LivechatSessionTaken',
      room: { _id: roomId },
      visitor: { token: visitorToken },
      agent: { _id: fakeAgentId, username: 'agente-real' },
    },
    SECRET as string,
  );
  const statusAfterTaken = await getQueueStatus();
  console.log(`    status atual: ${statusAfterTaken} (esperado: connected)`);
  if (statusAfterTaken !== 'connected') {
    console.error('    FALHA: Taken autenticado não conectou o visitante.');
    process.exitCode = 1;
  } else {
    console.log('    OK: frontend mostraria "conectado" imediatamente, como esperado.');
  }

  console.log(`\n[4] Encerrando sala simulada`);
  await postWebhook({ type: 'LivechatSessionClosed', room: { _id: roomId }, visitor: { token: visitorToken } }, SECRET as string);

  console.log(process.exitCode ? '\nResultado: FALHOU\n' : '\nResultado: OK\n');
}

main().catch((err) => {
  console.error('Erro ao rodar simulação:', err);
  process.exit(1);
});
