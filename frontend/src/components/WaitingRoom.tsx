import { useEffect, useRef, useState } from 'react';
import ChatRoom from './ChatRoom';

type AppState = 'loading' | 'queued' | 'connecting' | 'chat' | 'error' | 'no_token' | 'expired';

interface QueueData {
  position: number;
  queueSize: number;
  estimatedWaitSeconds?: number;
}

const RC_URL = 'https://desk.sapios.chat';

function ordinal(n: number): string {
  if (n === 1) return '1º';
  if (n === 2) return '2º';
  if (n === 3) return '3º';
  return `${n}º`;
}

function formatWait(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const min = Math.ceil(seconds / 60);
  return min === 1 ? 'aprox. 1 minuto' : `aprox. ${min} minutos`;
}

export default function WaitingRoom() {
  const [appState, setAppState] = useState<AppState>('loading');
  const [queueData, setQueueData] = useState<QueueData | null>(null);
  const [chatRoomId, setChatRoomId] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const connectedRef = useRef(false);
  const [reopening, setReopening] = useState(false);
  // null = unknown (no warning shown); false = RC reports no agent online.
  const [agentsOnline, setAgentsOnline] = useState<boolean | null>(null);
  const [noAgentOnline, setNoAgentOnline] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const visitorToken = params.get('token');
  const visitorName = params.get('nome') ?? params.get('name') ?? undefined;
  const visitorPhone = params.get('tel') ?? params.get('phone') ?? undefined;
  // roomId may come from URL (set by EntryPage) or from the SSE connected event
  const urlRoomId = params.get('room') ?? null;

  useEffect(() => {
    if (!visitorToken) {
      setAppState('no_token');
      return;
    }
    // Restore chatRoomId from URL if already connected (page refresh after chat started)
    if (urlRoomId) setChatRoomId(urlRoomId);
    connect();
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect() {
    cleanup();
    const url = `/queue/stream/${encodeURIComponent(visitorToken!)}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener('queue_update', (e) => {
      setConnectionError(false);
      retryCountRef.current = 0;
      const data = JSON.parse(e.data) as QueueData;
      setQueueData(data);
      setAppState('queued');
    });

    es.addEventListener('connected', (e) => {
      if (connectedRef.current) return;
      connectedRef.current = true;
      es.close();
      const data = JSON.parse(e.data) as { agentUrl?: string; roomId?: string };
      // roomId from SSE event is authoritative; URL roomId as fallback
      const rid = data.roomId ?? urlRoomId;
      if (rid) setChatRoomId(rid);
      setAppState('chat');
    });

    es.addEventListener('waiting', () => {
      setAppState('loading');
    });

    // No active room for this token at all (e.g. it already closed since
    // this link was last opened) — distinct from a transient reconnect, so
    // offer to reopen instead of spinning on "checking your position" forever.
    es.addEventListener('no_room', () => {
      es.close();
      setAppState('expired');
    });

    es.onerror = () => {
      setConnectionError(true);
      es.close();
      const delay = Math.min(1000 * 2 ** retryCountRef.current, 30_000);
      retryCountRef.current += 1;
      retryTimeoutRef.current = setTimeout(connect, delay);
    };
  }

  // While queued, check every 30s whether any agent is online, to warn the
  // visitor instead of leaving them waiting without knowing why.
  useEffect(() => {
    if (appState !== 'queued' || !visitorToken) return;
    let cancelled = false;
    const check = () => {
      fetch(`/queue/agents-online/${encodeURIComponent(visitorToken)}`)
        .then(res => res.ok ? res.json() : null)
        .then((body: { online?: boolean | null } | null) => {
          if (!cancelled) setAgentsOnline(typeof body?.online === 'boolean' ? body.online : null);
        })
        .catch(() => {});
    };
    check();
    const id = setInterval(check, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [appState, visitorToken]);

  function cleanup() {
    eventSourceRef.current?.close();
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
  }

  async function reopenConversation() {
    if (!visitorToken) return;
    setReopening(true);
    setNoAgentOnline(false);
    try {
      const res = await fetch('/visitors/reopen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: visitorToken }),
      });
      const data = await res.json() as { ok: boolean; link?: string; error?: string };
      if (data.ok && data.link) {
        window.location.href = data.link;
        return;
      }
      if (data.error === 'no_agent_online') {
        setReopening(false);
        setNoAgentOnline(true);
        return;
      }
    } catch {
      // fall through to error state below
    }
    setReopening(false);
    setAppState('error');
  }

  if (appState === 'chat' && visitorToken && chatRoomId) {
    return (
      <ChatRoom
        visitorToken={visitorToken}
        roomId={chatRoomId}
        visitorName={visitorName}
        visitorPhone={visitorPhone}
        rcUrl={RC_URL}
      />
    );
  }

  if (appState === 'chat' && visitorToken && !chatRoomId) {
    return (
      <div style={styles.card}>
        <Logo />
        <div style={styles.stateArea}>
          <Spinner />
          <p style={styles.primaryText}>Conectando ao agente...</p>
        </div>
      </div>
    );
  }

  if (appState === 'no_token') return <ErrorCard message="Token do visitante não encontrado na URL." />;

  return (
    <div style={styles.card}>
      <Logo />
      {appState === 'loading' && <LoadingState connectionError={connectionError} />}
      {appState === 'queued' && queueData && <QueuedState data={queueData} agentsOnline={agentsOnline} />}
      {appState === 'connecting' && <ConnectingState />}
      {appState === 'expired' && <ExpiredState reopening={reopening} noAgentOnline={noAgentOnline} onReopen={reopenConversation} />}
      {appState === 'error' && <ErrorCard message="Erro inesperado. Por favor, recarregue a página." />}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Logo() {
  return (
    <div style={styles.logoArea}>
      <div style={styles.logoIcon}>💬</div>
      <h1 style={styles.logoTitle}>Atendimento</h1>
    </div>
  );
}

function LoadingState({ connectionError }: { connectionError: boolean }) {
  return (
    <div style={styles.stateArea}>
      <Spinner />
      <p style={styles.primaryText}>
        {connectionError ? 'Reconectando...' : 'Verificando sua posição na fila...'}
      </p>
      {connectionError && (
        <p style={styles.mutedText}>A conexão caiu. Tentando reconectar automaticamente.</p>
      )}
    </div>
  );
}

function QueuedState({ data, agentsOnline }: { data: QueueData; agentsOnline: boolean | null }) {
  const wait = formatWait(data.estimatedWaitSeconds);
  return (
    <div style={styles.stateArea}>
      {agentsOnline === false && (
        <div style={styles.offlineNotice} role="status">
          <span style={styles.offlineDot} />
          <div>
            <p style={styles.offlineTitle}>No momento não há atendentes online</p>
            <p style={styles.offlineText}>
              Sua solicitação continua na fila e você será atendido assim que um atendente ficar disponível.
            </p>
          </div>
        </div>
      )}
      <div style={styles.positionBadge}>
        <span style={styles.positionNumber}>{ordinal(data.position)}</span>
        <span style={styles.positionLabel}>na fila</span>
      </div>
      <p style={styles.primaryText}>
        {data.position === 1
          ? 'Você é o próximo! Um agente estará com você em breve.'
          : `Você é o ${ordinal(data.position)} na fila. Aguarde um momento.`}
      </p>
      {wait && <p style={styles.mutedText}>Tempo estimado de espera: {wait}</p>}
      <QueueBar position={data.position} total={data.queueSize} />
      <p style={styles.hint}>Esta página atualiza automaticamente. Não feche a aba.</p>
    </div>
  );
}

function ExpiredState({ reopening, noAgentOnline, onReopen }: { reopening: boolean; noAgentOnline: boolean; onReopen: () => void }) {
  return (
    <div style={styles.stateArea}>
      <div style={{ fontSize: '2rem' }}>⏱️</div>
      <p style={styles.primaryText}>Este atendimento não está mais ativo.</p>
      {noAgentOnline && (
        <div style={styles.offlineNotice} role="status">
          <span style={styles.offlineDot} />
          <div>
            <p style={styles.offlineTitle}>No momento não há atendentes online</p>
            <p style={styles.offlineText}>Tente novamente em alguns minutos.</p>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={onReopen}
        disabled={reopening}
        style={{
          background: 'var(--color-primary)', color: '#fff', border: 'none',
          padding: '0.6rem 1.25rem', borderRadius: 999, fontSize: '0.9rem',
          fontWeight: 600, cursor: reopening ? 'default' : 'pointer', opacity: reopening ? 0.6 : 1,
        }}
      >
        {reopening ? 'Verificando...' : noAgentOnline ? 'Tentar novamente' : 'Iniciar novo atendimento'}
      </button>
    </div>
  );
}

function ConnectingState() {
  return (
    <div style={{ ...styles.stateArea, background: 'var(--color-success-light)', borderRadius: 12, padding: '1.5rem' }}>
      <div style={{ fontSize: '2.5rem' }}>✅</div>
      <p style={{ ...styles.primaryText, color: 'var(--color-success)' }}>
        Um agente está pronto para atendê-lo!
      </p>
      <p style={styles.mutedText}>Abrindo o chat...</p>
      <Spinner color="var(--color-success)" />
    </div>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div style={styles.card}>
      <Logo />
      <div style={styles.stateArea}>
        <div style={{ fontSize: '2rem' }}>⚠️</div>
        <p style={styles.primaryText}>{message}</p>
      </div>
    </div>
  );
}

function QueueBar({ position, total }: { position: number; total: number }) {
  const pct = total <= 1 ? 100 : Math.round(((total - position) / (total - 1)) * 100);
  return (
    <div style={{ width: '100%' }}>
      <div style={styles.barWrap}>
        <div style={{ ...styles.barFill, width: `${pct}%` }} />
      </div>
      <p style={styles.barLabel}>{total} pessoa{total !== 1 ? 's' : ''} na fila</p>
    </div>
  );
}

function Spinner({ color = 'var(--color-primary)' }: { color?: string }) {
  return (
    <div style={{
      width: 40, height: 40, borderRadius: '50%',
      border: `3px solid ${color}20`, borderTopColor: color,
      animation: 'spin 0.8s linear infinite', margin: '0 auto',
    }} />
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: 'var(--color-card)', borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)', padding: '2rem 1.5rem',
    display: 'flex', flexDirection: 'column', gap: '1.5rem', textAlign: 'center',
  },
  logoArea: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' },
  logoIcon: { fontSize: '2.5rem' },
  logoTitle: { fontSize: '1.5rem', fontWeight: 700, color: 'var(--color-text)' },
  stateArea: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' },
  positionBadge: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    background: 'var(--color-primary-light)', borderRadius: 12, padding: '1rem 2rem',
  },
  positionNumber: { fontSize: '3rem', fontWeight: 700, color: 'var(--color-primary)', lineHeight: 1 },
  positionLabel: { fontSize: '0.875rem', color: 'var(--color-primary)', fontWeight: 500, marginTop: '0.25rem' },
  primaryText: { fontSize: '1rem', fontWeight: 500, color: 'var(--color-text)', lineHeight: 1.5, maxWidth: 320 },
  mutedText: { fontSize: '0.875rem', color: 'var(--color-muted)', lineHeight: 1.5 },
  hint: { fontSize: '0.75rem', color: 'var(--color-muted)', fontStyle: 'italic' },
  barWrap: {
    width: '100%', background: 'var(--color-border)',
    borderRadius: 999, height: 8, overflow: 'hidden',
  },
  barFill: { height: '100%', background: 'var(--color-primary)', borderRadius: 999, transition: 'width 0.6s ease' },
  offlineNotice: {
    display: 'flex', alignItems: 'flex-start', gap: '0.65rem', width: '100%',
    background: '#FEF3C7', border: '1px solid #FCD34D', borderRadius: 12,
    padding: '0.85rem 1rem', textAlign: 'left',
  },
  offlineDot: {
    width: 10, height: 10, borderRadius: '50%', background: '#F59E0B',
    flexShrink: 0, marginTop: '0.35rem',
  },
  offlineTitle: { fontSize: '0.9rem', fontWeight: 600, color: '#92400E', lineHeight: 1.4 },
  offlineText: { fontSize: '0.8rem', color: '#92400E', lineHeight: 1.45, marginTop: '0.15rem', opacity: 0.9 },
  barLabel: { fontSize: '0.75rem', color: 'var(--color-muted)', textAlign: 'center', marginTop: 8 },
};
