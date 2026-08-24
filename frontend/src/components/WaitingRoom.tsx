import { useEffect, useRef, useState } from 'react';
import ChatRoom from './ChatRoom';

type AppState = 'loading' | 'queued' | 'connecting' | 'chat' | 'error' | 'no_token';

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

    es.onerror = () => {
      setConnectionError(true);
      es.close();
      const delay = Math.min(1000 * 2 ** retryCountRef.current, 30_000);
      retryCountRef.current += 1;
      retryTimeoutRef.current = setTimeout(connect, delay);
    };
  }

  function cleanup() {
    eventSourceRef.current?.close();
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
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
      {appState === 'queued' && queueData && <QueuedState data={queueData} />}
      {appState === 'connecting' && <ConnectingState />}
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

function QueuedState({ data }: { data: QueueData }) {
  const wait = formatWait(data.estimatedWaitSeconds);
  return (
    <div style={styles.stateArea}>
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
  barLabel: { fontSize: '0.75rem', color: 'var(--color-muted)', textAlign: 'center', marginTop: 8 },
};
