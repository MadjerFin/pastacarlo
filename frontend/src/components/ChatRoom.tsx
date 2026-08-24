import { useCallback, useEffect, useRef, useState } from 'react';

interface RcMessage {
  _id: string;
  msg: string;
  ts: string;
  u: { _id?: string; username: string; name?: string };
  token?: string;
  attachments?: Array<{
    title?: string;
    title_link?: string;
    image_url?: string;
    type?: string;
    description?: string;
  }>;
  file?: { name: string; type: string };
  t?: string;
}

interface Props {
  visitorToken: string;
  roomId: string;
  visitorName?: string;
  rcUrl: string;
}

const POLL_MS = 2500;

export default function ChatRoom({ visitorToken, roomId, visitorName, rcUrl }: Props) {
  const [messages, setMessages] = useState<RcMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const lastTsRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);

  const fetchMessages = useCallback(async (since?: string | null) => {
    const url = `/chat/messages/${encodeURIComponent(roomId)}?token=${encodeURIComponent(visitorToken)}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json() as { messages?: RcMessage[]; success?: boolean };
    return body.messages ?? null;
  }, [roomId, visitorToken]);

  const mergeMessages = useCallback((incoming: RcMessage[]) => {
    // Filter out system messages (t field = event type like 'uj', 'ul', etc.)
    const valid = incoming.filter(m => !m.t || m.msg);
    if (!valid.length) return;
    // RC returns newest-first; sort chronologically
    const sorted = [...valid].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    setMessages(prev => {
      const seen = new Set(prev.map(m => m._id));
      const fresh = sorted.filter(m => !seen.has(m._id));
      if (!fresh.length) return prev;
      const next = [...prev, ...fresh];
      lastTsRef.current = fresh[fresh.length - 1].ts;
      return next;
    });
    scrollToBottom();
  }, []);

  useEffect(() => {
    // Initial load
    fetchMessages(null).then(msgs => { if (msgs) mergeMessages(msgs); }).catch(console.error);

    pollRef.current = setInterval(() => {
      fetchMessages(lastTsRef.current).then(msgs => { if (msgs) mergeMessages(msgs); }).catch(console.error);
    }, POLL_MS);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchMessages, mergeMessages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || sending) return;
    setSending(true);
    setText('');
    try {
      const res = await fetch('/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: visitorToken, roomId, msg }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setError('Erro ao enviar mensagem. Tente novamente.');
      setText(msg);
    } finally {
      setSending(false);
    }
  }

  async function uploadFile(file: File) {
    setUploading(true);
    const form = new FormData();
    form.append('file', file);
    try {
      const res = await fetch(`/chat/upload/${encodeURIComponent(roomId)}?token=${encodeURIComponent(visitorToken)}`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error();
    } catch {
      setError('Erro ao enviar arquivo.');
    } finally {
      setUploading(false);
    }
  }

  function isFromVisitor(msg: RcMessage) {
    return msg.token === visitorToken || msg.u.username?.startsWith('guest-');
  }

  function buildAttachUrl(path?: string) {
    if (!path) return null;
    return path.startsWith('http') ? path : `${rcUrl}${path}`;
  }

  return (
    <div style={S.root}>
      {/* Header */}
      <header style={S.header}>
        <div style={S.avatar}>💬</div>
        <div>
          <div style={S.headerTitle}>Atendimento</div>
          <div style={S.headerSub}>
            {visitorName ? `Olá, ${visitorName}` : 'Conectado com um agente'}
          </div>
        </div>
      </header>

      {/* Messages */}
      <div style={S.messageList}>
        {messages.length === 0 && (
          <p style={S.empty}>Conectado! Aguarde uma mensagem do agente.</p>
        )}
        {messages.map(msg => {
          const mine = isFromVisitor(msg);
          return (
            <div key={msg._id} style={{ ...S.row, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
              <div style={{ ...S.bubble, ...(mine ? S.bubbleMe : S.bubbleAgent) }}>
                {!mine && (
                  <div style={S.senderName}>{msg.u.name ?? msg.u.username}</div>
                )}
                {msg.msg && <p style={S.msgText}>{msg.msg}</p>}
                {msg.attachments?.map((att, i) => {
                  const imgSrc = buildAttachUrl(att.image_url);
                  const fileSrc = buildAttachUrl(att.title_link);
                  return (
                    <div key={i} style={S.attach}>
                      {imgSrc ? (
                        <img src={imgSrc} alt={att.title ?? 'imagem'} style={S.attachImg} />
                      ) : fileSrc ? (
                        <a href={fileSrc} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                          📎 {att.title ?? 'Arquivo'}
                        </a>
                      ) : null}
                      {att.description && (
                        <p style={S.attachDesc}>{att.description}</p>
                      )}
                    </div>
                  );
                })}
                <div style={S.ts}>{fmtTime(msg.ts)}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Error bar */}
      {error && (
        <div style={S.errorBar} onClick={() => setError(null)}>
          ⚠️ {error} <span style={{ opacity: 0.6, fontSize: '0.75rem' }}>(toque para fechar)</span>
        </div>
      )}

      {/* Input */}
      <form onSubmit={send} style={S.inputRow}>
        <input
          type="file"
          ref={fileRef}
          style={{ display: 'none' }}
          accept="image/*,audio/*,video/*,.pdf,.doc,.docx,.xls,.xlsx"
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) uploadFile(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          style={S.iconBtn}
          title="Anexar arquivo"
          disabled={uploading}
        >
          {uploading ? '⏳' : '📎'}
        </button>
        <input
          style={S.textInput}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Digite uma mensagem..."
          disabled={sending}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(e as unknown as React.FormEvent);
            }
          }}
        />
        <button
          type="submit"
          style={{ ...S.iconBtn, ...S.sendBtn, opacity: sending || !text.trim() ? 0.5 : 1 }}
          disabled={sending || !text.trim()}
        >
          ➤
        </button>
      </form>
    </div>
  );
}

function fmtTime(ts: string) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column',
    height: '100dvh', maxWidth: 640, margin: '0 auto',
    background: '#f1f5f9', fontFamily: 'system-ui, sans-serif',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    padding: '0.875rem 1rem', background: '#2563eb', color: '#fff', flexShrink: 0,
    boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
  },
  avatar: { fontSize: '1.75rem', lineHeight: 1 },
  headerTitle: { fontWeight: 700, fontSize: '1rem', lineHeight: 1.2 },
  headerSub: { fontSize: '0.75rem', opacity: 0.82, marginTop: '0.1rem' },
  messageList: {
    flex: 1, overflowY: 'auto', padding: '1rem',
    display: 'flex', flexDirection: 'column', gap: '0.375rem',
  },
  empty: {
    textAlign: 'center', color: '#94a3b8', fontSize: '0.875rem',
    padding: '2rem 1rem', margin: 0,
  },
  row: { display: 'flex', width: '100%' },
  bubble: {
    maxWidth: '76%', padding: '0.5rem 0.75rem',
    borderRadius: 16, fontSize: '0.9rem', lineHeight: 1.5,
    wordBreak: 'break-word',
  },
  bubbleAgent: {
    background: '#fff', color: '#1e293b', borderTopLeftRadius: 4,
    boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
  },
  bubbleMe: {
    background: '#2563eb', color: '#fff', borderTopRightRadius: 4,
  },
  senderName: {
    fontSize: '0.68rem', fontWeight: 700, marginBottom: '0.2rem',
    opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  msgText: { margin: 0, whiteSpace: 'pre-wrap' },
  attach: { marginTop: '0.4rem' },
  attachImg: { maxWidth: 220, borderRadius: 8, display: 'block', marginTop: '0.25rem' },
  attachDesc: { fontSize: '0.78rem', margin: '0.2rem 0 0', opacity: 0.75 },
  ts: { fontSize: '0.6rem', opacity: 0.5, textAlign: 'right', marginTop: '0.3rem' },
  errorBar: {
    background: '#fee2e2', color: '#b91c1c',
    padding: '0.5rem 1rem', fontSize: '0.85rem',
    textAlign: 'center', cursor: 'pointer', flexShrink: 0,
  },
  inputRow: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.625rem 0.75rem', background: '#fff',
    borderTop: '1px solid #e2e8f0', flexShrink: 0,
  },
  textInput: {
    flex: 1, border: '1px solid #e2e8f0', borderRadius: 999,
    padding: '0.55rem 0.875rem', fontSize: '0.9rem',
    outline: 'none', background: '#f8fafc', minWidth: 0,
  },
  iconBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: '1.1rem', padding: '0.375rem', borderRadius: 8,
    flexShrink: 0, lineHeight: 1,
  },
  sendBtn: {
    background: '#2563eb', color: '#fff',
    borderRadius: '50%', width: 36, height: 36,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '0.9rem',
  },
};
