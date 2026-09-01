import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
    audio_url?: string;
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
  visitorPhone?: string;
  rcUrl: string;
}

const POLL_MS = 2500;

export default function ChatRoom({ visitorToken, roomId, visitorName, visitorPhone, rcUrl }: Props) {
  const [messages, setMessages] = useState<RcMessage[]>([]);
  const [pastMessages, setPastMessages] = useState<RcMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomClosed, setRoomClosed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const endRef = useRef<HTMLDivElement>(null);
  const lastTsRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendOnStopRef = useRef(true);

  const scrollToBottom = () => setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);

  const fetchMessages = useCallback(async (since?: string | null) => {
    const url = `/chat/messages/${encodeURIComponent(roomId)}?token=${encodeURIComponent(visitorToken)}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json() as { messages?: RcMessage[]; success?: boolean };
    return body.messages ?? null;
  }, [roomId, visitorToken]);

  const mergeMessages = useCallback((incoming: RcMessage[]) => {
    if (!incoming.length) return;

    // Advance the "since" cursor past every message seen (system ones included),
    // otherwise a poll that only returns a system message keeps re-fetching it.
    for (const m of incoming) {
      if (!lastTsRef.current || m.ts > lastTsRef.current) lastTsRef.current = m.ts;
    }

    // RC sends room closure (by agent OR visitor) as a system message with this
    // type. Without watching for it, the visitor only learns the chat ended
    // when they try to send something and get a 409 back.
    if (incoming.some(m => m.t === 'livechat-close')) {
      setRoomClosed(true);
    }

    // Filter out system messages (t field = event type, e.g. 'uj', 'command'/"connected",
    // 'livechat-close'/"Closed by visitor" — these carry real text but aren't chat content)
    const valid = incoming.filter(m => !m.t);
    if (!valid.length) return;
    // RC returns newest-first; sort chronologically
    const sorted = [...valid].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    setMessages(prev => {
      const seen = new Set(prev.map(m => m._id));
      const fresh = sorted.filter(m => !seen.has(m._id));
      if (!fresh.length) return prev;
      return [...prev, ...fresh];
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

  useEffect(() => {
    // Load messages from the visitor's earlier (already closed) conversations
    const url = `/chat/history/${encodeURIComponent(visitorToken)}?currentRoomId=${encodeURIComponent(roomId)}`;
    fetch(url)
      .then(res => res.ok ? res.json() : null)
      .then((body: { messages?: RcMessage[] } | null) => {
        const raw = body?.messages ?? [];
        const valid = raw.filter(m => !m.t);
        const sorted = [...valid].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
        setPastMessages(sorted);
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full timeline: past (closed) conversations followed by the live one, deduped by id
  const timeline = useMemo(() => {
    const seen = new Set<string>();
    const all: RcMessage[] = [];
    for (const m of [...pastMessages, ...messages]) {
      if (seen.has(m._id)) continue;
      seen.add(m._id);
      all.push(m);
    }
    return all;
  }, [pastMessages, messages]);

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
      if (res.status === 409) {
        const body = await res.json() as { error?: string };
        if (body.error === 'room-closed') { setRoomClosed(true); return; }
        throw new Error();
      }
      if (!res.ok) throw new Error();
    } catch {
      setError('Erro ao enviar mensagem. Tente novamente.');
      setText(msg);
    } finally {
      setSending(false);
      textInputRef.current?.focus();
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
      if (res.status === 409) {
        const body = await res.json() as { error?: string };
        if (body.error === 'room-closed') { setRoomClosed(true); return; }
        throw new Error();
      }
      if (!res.ok) throw new Error();
    } catch {
      setError('Erro ao enviar arquivo.');
    } finally {
      setUploading(false);
    }
  }

  function extFor(mimeType: string) {
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('ogg')) return 'ogg';
    return 'webm';
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(t => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (sendOnStopRef.current && audioChunksRef.current.length) {
          const type = recorder.mimeType || 'audio/webm';
          const blob = new Blob(audioChunksRef.current, { type });
          const file = new File([blob], `audio-message.${extFor(type)}`, { type });
          uploadFile(file);
        }
        audioChunksRef.current = [];
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
    } catch {
      setError('Não foi possível acessar o microfone.');
    }
  }

  function stopRecording(shouldSend: boolean) {
    sendOnStopRef.current = shouldSend;
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    setRecording(false);
    setRecordSeconds(0);
  }

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  async function closeConversation() {
    if (!window.confirm('Tem certeza que deseja encerrar esta conversa?')) return;
    setClosing(true);
    try {
      const res = await fetch('/chat/close', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: visitorToken, roomId }),
      });
      if (res.ok || res.status === 409) { setRoomClosed(true); return; }
      throw new Error();
    } catch {
      setError('Erro ao encerrar a conversa. Tente novamente.');
    } finally {
      setClosing(false);
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
        <div style={{ flex: 1 }}>
          <div style={S.headerTitle}>Atendimento</div>
          <div style={S.headerSub}>
            {visitorName ? `Olá, ${visitorName}` : 'Conectado com um agente'}
          </div>
        </div>
        {!roomClosed && (
          <button
            type="button"
            onClick={closeConversation}
            disabled={closing}
            style={S.endBtn}
            title="Encerrar conversa"
          >
            {closing ? '⏳' : 'Encerrar'}
          </button>
        )}
      </header>

      {/* Messages */}
      <div style={S.messageList}>
        {timeline.length === 0 && (
          <p style={S.empty}>Conectado! Aguarde uma mensagem do agente.</p>
        )}
        {timeline.map((msg, i) => {
          const mine = isFromVisitor(msg);
          const prev = timeline[i - 1];
          const showDivider = !prev || dayKey(prev.ts) !== dayKey(msg.ts);
          return (
            <div key={msg._id}>
              {showDivider && (
                <div style={S.dividerRow}>
                  <span style={S.dividerPill}>{dayLabel(msg.ts)}</span>
                </div>
              )}
              <div style={{ ...S.row, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                <div style={{ ...S.bubble, ...(mine ? S.bubbleMe : S.bubbleAgent) }}>
                  {!mine && (
                    <div style={S.senderName}>{msg.u.name ?? msg.u.username}</div>
                  )}
                  {msg.msg && <p style={S.msgText}>{msg.msg}</p>}
                  {msg.attachments?.map((att, ai) => {
                    const imgSrc = buildAttachUrl(att.image_url);
                    const audioSrc = buildAttachUrl(att.audio_url);
                    const fileSrc = buildAttachUrl(att.title_link);
                    return (
                      <div key={ai} style={S.attach}>
                        {audioSrc ? (
                          <audio controls src={audioSrc} style={S.attachAudio} />
                        ) : imgSrc ? (
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
                  <div style={S.metaRow}>
                    <span style={S.ts}>{fmtTime(msg.ts)}</span>
                    {mine && <span style={S.check}>✓✓</span>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Error bar */}
      {error && !roomClosed && (
        <div style={S.errorBar} onClick={() => setError(null)}>
          ⚠️ {error} <span style={{ opacity: 0.6, fontSize: '0.75rem' }}>(toque para fechar)</span>
        </div>
      )}

      {/* Sala encerrada — bloqueia o envio e oferece iniciar um novo atendimento */}
      {roomClosed && (
        <div style={S.closedBar}>
          <span>Esta conversa foi encerrada.</span>
          <button
            type="button"
            style={S.reloadBtn}
            onClick={() => {
              if (visitorName && visitorPhone) {
                const params = new URLSearchParams({ nome: visitorName, tel: visitorPhone });
                window.location.href = `/entrar?${params.toString()}`;
              } else {
                window.location.reload();
              }
            }}
          >
            Iniciar novo atendimento
          </button>
        </div>
      )}

      {/* Input */}
      {recording ? (
        <div style={S.inputRow}>
          <button type="button" onClick={() => stopRecording(false)} style={S.iconBtn} title="Cancelar gravação">
            🗑️
          </button>
          <div style={S.recordIndicator}>
            <span style={S.recordDot} />
            <span>Gravando... {fmtDuration(recordSeconds)}</span>
          </div>
          <button type="button" onClick={() => stopRecording(true)} style={{ ...S.iconBtn, ...S.sendBtn }} title="Enviar áudio">
            ➤
          </button>
        </div>
      ) : (
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
            disabled={uploading || roomClosed}
          >
            {uploading ? '⏳' : '📎'}
          </button>
          <input
            ref={textInputRef}
            style={S.textInput}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={roomClosed ? 'Conversa encerrada' : 'Digite uma mensagem...'}
            disabled={roomClosed}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(e as unknown as React.FormEvent);
              }
            }}
          />
          {text.trim() ? (
            <button
              type="submit"
              style={{ ...S.iconBtn, ...S.sendBtn, opacity: sending || roomClosed ? 0.5 : 1 }}
              disabled={sending || roomClosed}
            >
              ➤
            </button>
          ) : (
            <button
              type="button"
              onClick={startRecording}
              style={{ ...S.iconBtn, ...S.sendBtn, opacity: roomClosed ? 0.5 : 1 }}
              disabled={roomClosed}
              title="Gravar áudio"
            >
              🎤
            </button>
          )}
        </form>
      )}
    </div>
  );
}

function fmtDuration(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const s = (totalSeconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function fmtTime(ts: string) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts: string) {
  return new Date(ts).toDateString();
}

function dayLabel(ts: string) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today.toISOString())) return 'Hoje';
  if (dayKey(ts) === dayKey(yesterday.toISOString())) return 'Ontem';
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: sameYear ? undefined : 'numeric',
  });
}

// Textura de fundo sutil (papel/doodle), no estilo do WhatsApp — SVG inline, sem asset externo
const CHAT_BG_PATTERN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 100 100'%3E%3Cg fill='%23000000' fill-opacity='0.025'%3E%3Ccircle cx='10' cy='10' r='1.5'/%3E%3Ccircle cx='50' cy='30' r='1.5'/%3E%3Ccircle cx='85' cy='15' r='1.5'/%3E%3Ccircle cx='30' cy='60' r='1.5'/%3E%3Ccircle cx='70' cy='70' r='1.5'/%3E%3Ccircle cx='15' cy='85' r='1.5'/%3E%3Ccircle cx='90' cy='90' r='1.5'/%3E%3C/g%3E%3C/svg%3E")`;

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column',
    height: '100dvh', maxWidth: 640, margin: '0 auto',
    background: '#ECE5DD', fontFamily: 'system-ui, sans-serif',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    padding: '0.75rem 1rem', background: '#075E54', color: '#fff', flexShrink: 0,
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 1,
  },
  avatar: {
    fontSize: '1.4rem', lineHeight: 1, width: 40, height: 40, borderRadius: '50%',
    background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  headerTitle: { fontWeight: 600, fontSize: '1rem', lineHeight: 1.2 },
  headerSub: { fontSize: '0.75rem', opacity: 0.85, marginTop: '0.15rem' },
  endBtn: {
    background: 'rgba(255,255,255,0.15)', color: '#fff', border: 'none',
    padding: '0.4rem 0.85rem', borderRadius: 999, fontSize: '0.78rem',
    fontWeight: 600, cursor: 'pointer', flexShrink: 0,
  },
  messageList: {
    flex: 1, overflowY: 'auto', padding: '0.75rem 1rem',
    display: 'flex', flexDirection: 'column', gap: '0.25rem',
    backgroundColor: '#ECE5DD', backgroundImage: CHAT_BG_PATTERN,
  },
  empty: {
    textAlign: 'center', color: '#8a8a8a', fontSize: '0.85rem',
    padding: '2rem 1rem', margin: 0,
  },
  dividerRow: { display: 'flex', justifyContent: 'center', margin: '0.6rem 0' },
  dividerPill: {
    background: '#E1F3FB', color: '#4a5b60', fontSize: '0.72rem', fontWeight: 500,
    padding: '0.3rem 0.75rem', borderRadius: 8, boxShadow: '0 1px 1px rgba(0,0,0,0.08)',
  },
  row: { display: 'flex', width: '100%', marginBottom: '0.15rem' },
  bubble: {
    maxWidth: '76%', padding: '0.4rem 0.6rem 0.3rem',
    borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.4,
    wordBreak: 'break-word', boxShadow: '0 1px 0.5px rgba(0,0,0,0.13)',
  },
  bubbleAgent: {
    background: '#fff', color: '#111b21', borderTopLeftRadius: 0,
  },
  bubbleMe: {
    background: '#DCF8C6', color: '#111b21', borderTopRightRadius: 0,
  },
  senderName: {
    fontSize: '0.68rem', fontWeight: 700, marginBottom: '0.15rem',
    color: '#075E54',
  },
  msgText: { margin: 0, whiteSpace: 'pre-wrap' },
  attach: { marginTop: '0.4rem' },
  attachImg: { maxWidth: 220, borderRadius: 8, display: 'block', marginTop: '0.25rem' },
  attachAudio: { maxWidth: 240, width: '100%', display: 'block', marginTop: '0.25rem', height: 36 },
  recordIndicator: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
    color: '#54656f', fontSize: '0.9rem',
  },
  recordDot: {
    width: 10, height: 10, borderRadius: '50%', background: '#e53935',
    animation: 'blink 1s ease-in-out infinite',
  },
  attachDesc: { fontSize: '0.78rem', margin: '0.2rem 0 0', opacity: 0.75 },
  metaRow: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.25rem', marginTop: '0.15rem' },
  ts: { fontSize: '0.65rem', opacity: 0.55 },
  check: { fontSize: '0.7rem', color: '#53bdeb', letterSpacing: '-0.15em' },
  errorBar: {
    background: '#fee2e2', color: '#b91c1c',
    padding: '0.5rem 1rem', fontSize: '0.85rem',
    textAlign: 'center', cursor: 'pointer', flexShrink: 0,
  },
  closedBar: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem',
    background: '#FEF3C7', color: '#92400e',
    padding: '0.75rem 1rem', fontSize: '0.85rem',
    textAlign: 'center', flexShrink: 0,
  },
  reloadBtn: {
    background: '#075E54', color: '#fff', border: 'none',
    padding: '0.4rem 1rem', borderRadius: 999, fontSize: '0.8rem',
    fontWeight: 600, cursor: 'pointer',
  },
  inputRow: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    padding: '0.5rem 0.75rem', background: '#F0F0F0',
    borderTop: '1px solid #e2e8f0', flexShrink: 0,
  },
  textInput: {
    flex: 1, border: 'none', borderRadius: 999,
    padding: '0.6rem 1rem', fontSize: '0.9rem',
    outline: 'none', background: '#fff', minWidth: 0,
    boxShadow: '0 1px 1px rgba(0,0,0,0.08)',
  },
  iconBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: '1.2rem', padding: '0.375rem', borderRadius: 8,
    flexShrink: 0, lineHeight: 1, color: '#54656f',
  },
  sendBtn: {
    background: '#25D366', color: '#fff',
    borderRadius: '50%', width: 38, height: 38,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '0.9rem',
  },
};
