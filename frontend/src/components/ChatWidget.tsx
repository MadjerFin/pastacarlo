import { useEffect, useState } from 'react';

interface Props {
  visitorToken: string;
  rcUrl: string;
  visitorName?: string;
  agentUrl?: string; // URL completa com token+room do backend (preferida)
}

export default function ChatWidget({ visitorToken, rcUrl, agentUrl }: Props) {
  const [count, setCount] = useState(3);
  // Usa a URL do backend (com token+room) ou monta uma como fallback
  const chatUrl = agentUrl ?? `${rcUrl}/livechat?token=${encodeURIComponent(visitorToken)}`;

  useEffect(() => {
    if (count <= 0) {
      window.location.href = chatUrl;
      return;
    }
    const t = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [count, chatUrl]);

  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <div style={styles.icon}>✅</div>
        <h2 style={styles.title}>Agente disponível!</h2>
        <p style={styles.muted}>
          Abrindo o chat em <strong style={{ color: '#2563eb' }}>{count}</strong>...
        </p>
        <div style={styles.bar}>
          <div style={{ ...styles.barFill, width: `${((3 - count) / 3) * 100}%` }} />
        </div>
        <a href={chatUrl} style={styles.btn}>
          Entrar no chat agora
        </a>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100dvh', background: '#f0f4f8', padding: '1rem',
  },
  card: {
    background: '#fff', borderRadius: 16,
    boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
    padding: '2.5rem 2rem', maxWidth: 400, width: '100%',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: '1.25rem', textAlign: 'center',
  },
  icon: { fontSize: '3rem' },
  title: { fontSize: '1.4rem', fontWeight: 700, color: '#1e293b', margin: 0 },
  muted: { fontSize: '1rem', color: '#64748b', margin: 0 },
  bar: {
    width: '100%', height: 6, background: '#e2e8f0',
    borderRadius: 999, overflow: 'hidden',
  },
  barFill: {
    height: '100%', background: '#2563eb', borderRadius: 999,
    transition: 'width 0.9s linear',
  },
  btn: {
    background: '#2563eb', color: '#fff',
    padding: '0.75rem 2rem', borderRadius: 999,
    fontWeight: 600, fontSize: '1rem',
    textDecoration: 'none', display: 'inline-block',
    marginTop: '0.5rem',
  },
};
