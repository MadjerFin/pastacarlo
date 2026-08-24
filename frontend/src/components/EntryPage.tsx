import { useEffect, useState } from 'react';

type State = 'loading' | 'error';

export default function EntryPage() {
  const [state, setState] = useState<State>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  const params = new URLSearchParams(window.location.search);
  const name = params.get('nome') ?? params.get('name') ?? '';
  const phone = params.get('tel') ?? params.get('phone') ?? '';

  useEffect(() => {
    if (!name || !phone) {
      setErrorMsg('Link inválido. Nome e telefone são obrigatórios.');
      setState('error');
      return;
    }
    register();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function register() {
    try {
      const res = await fetch('/visitors/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone }),
      });
      const data = await res.json() as { ok: boolean; token?: string; roomId?: string; error?: string };

      if (!data.ok || !data.token) {
        setErrorMsg(data.error ?? 'Não foi possível iniciar o atendimento.');
        setState('error');
        return;
      }

      const params = new URLSearchParams({ token: data.token });
      if (data.roomId) params.set('room', data.roomId);
      if (name) params.set('nome', name);
      if (phone) params.set('tel', phone);
      window.location.href = `/?${params.toString()}`;
    } catch {
      setErrorMsg('Erro de conexão. Tente novamente.');
      setState('error');
    }
  }

  if (state === 'error') {
    return (
      <div style={card}>
        <div style={{ fontSize: '2rem' }}>⚠️</div>
        <p style={title}>Ops, algo deu errado</p>
        <p style={muted}>{errorMsg}</p>
      </div>
    );
  }

  return (
    <div style={card}>
      <div style={{ fontSize: '2.5rem' }}>💬</div>
      <p style={title}>Iniciando atendimento...</p>
      <p style={muted}>Olá, {name}! Estamos conectando você.</p>
      <Spinner />
    </div>
  );
}

function Spinner() {
  return (
    <div style={{
      width: 36, height: 36, borderRadius: '50%',
      border: '3px solid #dbeafe', borderTopColor: '#2563eb',
      animation: 'spin 0.8s linear infinite', margin: '0 auto',
    }} />
  );
}

const card: React.CSSProperties = {
  background: '#fff', borderRadius: 16,
  boxShadow: '0 4px 24px rgba(0,0,0,0.08)',
  padding: '2rem 1.5rem',
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', gap: '1rem', textAlign: 'center',
};
const title: React.CSSProperties = { fontSize: '1.1rem', fontWeight: 600, color: '#1e293b' };
const muted: React.CSSProperties = { fontSize: '0.9rem', color: '#64748b' };
