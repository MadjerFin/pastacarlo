// URL do widget de livechat com o token do visitante — usada para redirecionar
// quem já está com um agente conectado direto pro chat.
export function buildAgentUrl(visitorToken: string): string {
  const livechatBaseUrl = process.env.ROCKETCHAT_LIVECHAT_URL ?? `${process.env.ROCKETCHAT_URL ?? ''}/livechat`;
  return `${livechatBaseUrl}?token=${encodeURIComponent(visitorToken)}`;
}

export function appBaseUrl(): string {
  return (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

// Página do próprio app (WaitingRoom) — serve tanto pra fila quanto pra chat
// já conectado: ela abre um SSE e troca de tela sozinha (fila → chat) sem
// precisar de outro link. nome/tel são opcionais, mas sem eles o botão
// "Iniciar novo atendimento" dentro do chat (se a sala fechar depois) cai
// num reload que reabre a mesma sala fechada em vez de oferecer uma nova.
export function buildAppLink(visitorToken: string, roomId?: string, name?: string, phone?: string): string {
  const params = new URLSearchParams({ token: visitorToken });
  if (roomId) params.set('room', roomId);
  if (name) params.set('nome', name);
  if (phone) params.set('tel', phone);
  return `${appBaseUrl()}/?${params.toString()}`;
}

// Fluxo de registro/abertura de sala nova (EntryPage) — exige nome e telefone.
export function buildEntrarLink(name: string, phone: string): string {
  const params = new URLSearchParams({ nome: name, tel: phone });
  return `${appBaseUrl()}/entrar?${params.toString()}`;
}
