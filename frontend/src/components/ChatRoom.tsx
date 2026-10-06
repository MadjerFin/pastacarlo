import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface RcMessage {
  _id: string;
  rid?: string;
  msg: string;
  ts: string;
  // Display name override — set on the greeting, which the backend posts with
  // the admin token but under the name of the agent who took the chat.
  alias?: string;
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

// A message the visitor sent that RC hasn't confirmed yet — shown right away
// (instead of waiting up to POLL_MS for the next poll) and swapped for the
// real message once /chat/message answers.
interface PendingMessage {
  tempId: string;
  msg: string;
  ts: string;
  failed?: boolean;
}

interface Props {
  visitorToken: string;
  roomId: string;
  visitorName?: string;
  visitorPhone?: string;
  rcUrl: string;
}

const POLL_MS = 2500;
// Consecutive messages from the same sender closer than this are grouped
// into one block (sender name + bubble tail only on the first).
const GROUP_WINDOW_MS = 5 * 60 * 1000;
// How close to the bottom (px) still counts as "reading the latest" — new
// messages only auto-scroll when the visitor is here, so scrolling up to
// read history isn't interrupted by every incoming message.
const NEAR_BOTTOM_PX = 120;
const TEXTAREA_MAX_HEIGHT = 120;

export default function ChatRoom({ visitorToken, roomId, visitorName, rcUrl }: Props) {
  const [messages, setMessages] = useState<RcMessage[]>([]);
  const [pastMessages, setPastMessages] = useState<RcMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomClosed, setRoomClosed] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [noAgentOnline, setNoAgentOnline] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const lastSeenIdRef = useRef<string | null>(null);
  const lastTsRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendOnStopRef = useRef(true);

  // Full-screen layout — drops the waiting room's centered 480px card.
  useEffect(() => {
    document.body.classList.add('chat-active');
    return () => document.body.classList.remove('chat-active');
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior });
    });
    setHasNewBelow(false);
  }, []);

  function onListScroll() {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    nearBottomRef.current = near;
    if (near) setHasNewBelow(false);
  }

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
    setMessages(prev => {
      const seen = new Set(prev.map(m => m._id));
      const fresh = valid.filter(m => !seen.has(m._id));
      if (!fresh.length) return prev;
      return [...prev, ...fresh];
    });
  }, []);

  const pollNow = useCallback(() => {
    fetchMessages(lastTsRef.current).then(msgs => { if (msgs) mergeMessages(msgs); }).catch(console.error);
  }, [fetchMessages, mergeMessages]);

  useEffect(() => {
    // Initial load
    fetchMessages(null).then(msgs => { if (msgs) mergeMessages(msgs); }).catch(console.error);
    pollRef.current = setInterval(pollNow, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchMessages, mergeMessages, pollNow]);

  useEffect(() => {
    // Load messages from the visitor's earlier (already closed) conversations
    const url = `/chat/history/${encodeURIComponent(visitorToken)}?currentRoomId=${encodeURIComponent(roomId)}`;
    fetch(url)
      .then(res => res.ok ? res.json() : null)
      .then((body: { messages?: RcMessage[] } | null) => {
        const raw = body?.messages ?? [];
        setPastMessages(raw.filter(m => !m.t));
      })
      .catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Full timeline: past (closed) conversations followed by the live one,
  // deduped by id and sorted chronologically (RC returns newest-first, and a
  // message confirmed by /chat/message can land before an older poll result).
  const timeline = useMemo(() => {
    const byId = new Map<string, RcMessage>();
    for (const m of [...pastMessages, ...messages]) byId.set(m._id, m);
    return [...byId.values()].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }, [pastMessages, messages]);

  const isFromVisitor = useCallback((msg: RcMessage) => {
    return msg.token === visitorToken || msg.u.username?.startsWith('guest-');
  }, [visitorToken]);

  // Most recent agent in the current room — shown in the header.
  const agentName = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!isFromVisitor(m)) return senderName(m);
    }
    return null;
  }, [messages, isFromVisitor]);

  // Auto-scroll on new messages only when the visitor is already at the
  // bottom (or sent it themselves); otherwise show the "new messages" button.
  useEffect(() => {
    const last = timeline[timeline.length - 1];
    if (!last || last._id === lastSeenIdRef.current) return;
    const isFirstLoad = lastSeenIdRef.current === null;
    lastSeenIdRef.current = last._id;
    if (isFirstLoad) scrollToBottom('auto');
    else if (nearBottomRef.current || isFromVisitor(last)) scrollToBottom();
    else setHasNewBelow(true);
  }, [timeline, isFromVisitor, scrollToBottom]);

  async function deliver(p: PendingMessage) {
    setPending(prev => prev.map(x => x.tempId === p.tempId ? { ...x, failed: false } : x));
    try {
      const res = await fetch('/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: visitorToken, roomId, msg: p.msg }),
      });
      if (res.status === 409) {
        const body = await res.json() as { error?: string };
        if (body.error === 'room-closed') setRoomClosed(true);
        throw new Error();
      }
      if (!res.ok) throw new Error();
      const body = await res.json() as { message?: RcMessage };
      const confirmed = body.message;
      // Insert the confirmed message directly (without moving the poll
      // cursor — an agent message older than this one may still be unfetched).
      if (confirmed?._id && confirmed.ts) {
        setMessages(prev => prev.some(m => m._id === confirmed._id) ? prev : [...prev, confirmed]);
      }
      setPending(prev => prev.filter(x => x.tempId !== p.tempId));
      pollNow();
    } catch {
      setPending(prev => prev.map(x => x.tempId === p.tempId ? { ...x, failed: true } : x));
    }
  }

  function send(e?: React.FormEvent) {
    e?.preventDefault();
    const msg = text.trim();
    if (!msg || roomClosed) return;
    const p: PendingMessage = { tempId: `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`, msg, ts: new Date().toISOString() };
    setPending(prev => [...prev, p]);
    setText('');
    resizeTextarea(true);
    scrollToBottom();
    textInputRef.current?.focus();
    deliver(p);
  }

  function discardPending(tempId: string) {
    setPending(prev => prev.filter(x => x.tempId !== tempId));
  }

  function resizeTextarea(reset = false) {
    const el = textInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (!reset) el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
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
      pollNow();
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

  async function reopenConversation() {
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
      // RC won't open a room with nobody online — say so here instead of
      // reloading into this same closed conversation.
      if (data.error === 'no_agent_online') {
        setNoAgentOnline(true);
        return;
      }
      window.location.reload();
    } catch {
      window.location.reload();
    } finally {
      setReopening(false);
    }
  }

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

  function buildAttachUrl(path?: string) {
    if (!path) return null;
    return path.startsWith('http') ? path : `${rcUrl}${path}`;
  }

  // Index of the first message of the current room — a "current conversation"
  // marker goes there, separating it from earlier (closed) conversations.
  const firstCurrentIdx = pastMessages.length
    ? timeline.findIndex(m => m.rid ? m.rid === roomId : !pastMessages.some(p => p._id === m._id))
    : -1;

  return (
    <div style={S.root}>
      {/* Header */}
      <header style={S.header}>
        <div style={S.avatar}>
          {agentName ? initials(agentName) : <HeadsetIcon />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={S.headerTitle}>{agentName ?? 'Atendimento'}</div>
          <div style={S.headerSub}>
            {roomClosed ? (
              'Conversa encerrada'
            ) : (
              <>
                <span style={S.onlineDot} />
                {agentName ? 'Atendente' : visitorName ? `Olá, ${visitorName}` : 'Conectado'}
              </>
            )}
          </div>
        </div>
        {!roomClosed && (
          <button
            type="button"
            onClick={closeConversation}
            disabled={closing}
            style={{ ...S.endBtn, opacity: closing ? 0.6 : 1 }}
          >
            {closing ? 'Encerrando...' : 'Encerrar'}
          </button>
        )}
      </header>

      {/* Messages */}
      <div style={S.listWrap}>
        <div ref={listRef} style={S.messageList} onScroll={onListScroll}>
          {timeline.length === 0 && pending.length === 0 && (
            <div style={S.empty}>
              <div style={S.emptyIcon}><ChatBubbleIcon /></div>
              <p style={{ margin: 0, fontWeight: 600, color: '#3b4a54' }}>Você está conectado</p>
              <p style={{ margin: '0.25rem 0 0' }}>Envie uma mensagem ou aguarde o atendente.</p>
            </div>
          )}

          {timeline.map((msg, i) => {
            const mine = isFromVisitor(msg);
            const prev = timeline[i - 1];
            const showDay = !prev || dayKey(prev.ts) !== dayKey(msg.ts);
            const showCurrentMarker = i === firstCurrentIdx && i > 0;
            const grouped = !showDay && !showCurrentMarker && !!prev && sameSender(prev, msg, isFromVisitor);
            return (
              <div key={msg._id}>
                {showCurrentMarker && (
                  <div style={S.dividerRow}>
                    <span style={{ ...S.dividerPill, ...S.dividerCurrent }}>
                      Atendimento atual{showDay ? ` · ${dayLabel(msg.ts)}` : ''}
                    </span>
                  </div>
                )}
                {showDay && !showCurrentMarker && (
                  <div style={S.dividerRow}>
                    <span style={S.dividerPill}>{dayLabel(msg.ts)}</span>
                  </div>
                )}
                <div style={{ ...S.row, justifyContent: mine ? 'flex-end' : 'flex-start', marginTop: grouped ? 2 : 8 }}>
                  <div style={{
                    ...S.bubble,
                    ...(mine ? S.bubbleMe : S.bubbleAgent),
                    ...(grouped ? {} : mine ? { borderTopRightRadius: 0 } : { borderTopLeftRadius: 0 }),
                  }}>
                    {!mine && !grouped && (
                      <div style={S.senderName}>{senderName(msg)}</div>
                    )}
                    {msg.msg && <p style={S.msgText}>{linkify(msg.msg)}</p>}
                    {msg.attachments?.map((att, ai) => {
                      const imgSrc = buildAttachUrl(att.image_url);
                      const audioSrc = buildAttachUrl(att.audio_url);
                      const fileSrc = buildAttachUrl(att.title_link);
                      return (
                        <div key={ai} style={S.attach}>
                          {audioSrc ? (
                            <audio controls src={audioSrc} style={S.attachAudio} />
                          ) : imgSrc ? (
                            <a href={fileSrc ?? imgSrc} target="_blank" rel="noreferrer">
                              <img src={imgSrc} alt={att.title ?? 'imagem'} style={S.attachImg} />
                            </a>
                          ) : fileSrc ? (
                            <a href={fileSrc} target="_blank" rel="noreferrer" style={S.fileChip}>
                              <FileIcon />
                              <span style={S.fileName}>{att.title ?? 'Arquivo'}</span>
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
                      {mine && <span style={S.status}><CheckIcon /></span>}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {pending.map((p, i) => {
            const prevMine = i > 0 || (timeline.length > 0 && isFromVisitor(timeline[timeline.length - 1]));
            return (
              <div key={p.tempId} style={{ ...S.row, justifyContent: 'flex-end', marginTop: prevMine ? 2 : 8, flexDirection: 'column', alignItems: 'flex-end' }}>
                <div style={{ ...S.bubble, ...S.bubbleMe, ...(prevMine ? {} : { borderTopRightRadius: 0 }), opacity: p.failed ? 0.75 : 1 }}>
                  <p style={S.msgText}>{linkify(p.msg)}</p>
                  <div style={S.metaRow}>
                    <span style={S.ts}>{fmtTime(p.ts)}</span>
                    <span style={{ ...S.status, color: p.failed ? '#d93025' : '#8696a0' }}>
                      {p.failed ? <AlertIcon /> : <ClockIcon />}
                    </span>
                  </div>
                </div>
                {p.failed && (
                  <div style={S.failedRow}>
                    Não enviada.
                    {!roomClosed && (
                      <button type="button" style={S.linkBtn} onClick={() => deliver(p)}>Tentar de novo</button>
                    )}
                    <button type="button" style={S.linkBtn} onClick={() => discardPending(p.tempId)}>Descartar</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {hasNewBelow && (
          <button type="button" style={S.newBelowBtn} onClick={() => scrollToBottom()}>
            <ArrowDownIcon /> Novas mensagens
          </button>
        )}
      </div>

      {/* Error bar */}
      {error && !roomClosed && (
        <div style={S.errorBar} onClick={() => setError(null)}>
          <AlertIcon /> <span>{error}</span> <span style={{ opacity: 0.6, fontSize: '0.75rem' }}>(toque para fechar)</span>
        </div>
      )}

      {/* Sala encerrada — bloqueia o envio e oferece iniciar um novo atendimento */}
      {roomClosed ? (
        <div style={S.closedBar}>
          {noAgentOnline ? (
            <div style={S.offlineNotice} role="status">
              <strong style={{ display: 'block', marginBottom: '0.15rem' }}>No momento não há atendentes online</strong>
              Tente novamente em alguns minutos.
            </div>
          ) : (
            <span>Esta conversa foi encerrada.</span>
          )}
          <button
            type="button"
            style={{ ...S.reopenBtn, opacity: reopening ? 0.6 : 1 }}
            disabled={reopening}
            onClick={reopenConversation}
          >
            {reopening ? 'Verificando...' : noAgentOnline ? 'Tentar novamente' : 'Iniciar novo atendimento'}
          </button>
        </div>
      ) : recording ? (
        <div style={S.inputRow}>
          <button type="button" className="chat-icon-btn" onClick={() => stopRecording(false)} style={S.iconBtn} title="Cancelar gravação" aria-label="Cancelar gravação">
            <TrashIcon />
          </button>
          <div style={S.recordIndicator}>
            <span style={S.recordDot} />
            <span>Gravando {fmtDuration(recordSeconds)}</span>
          </div>
          <button type="button" onClick={() => stopRecording(true)} style={S.sendBtn} title="Enviar áudio" aria-label="Enviar áudio">
            <SendIcon />
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
          <div style={S.composer}>
            <button
              type="button"
              className="chat-icon-btn"
              onClick={() => fileRef.current?.click()}
              style={S.iconBtn}
              title="Anexar arquivo"
              aria-label="Anexar arquivo"
              disabled={uploading}
            >
              {uploading ? <span style={S.spinner} /> : <PaperclipIcon />}
            </button>
            <textarea
              ref={textInputRef}
              className="chat-input"
              rows={1}
              style={S.textInput}
              value={text}
              onChange={e => { setText(e.target.value); resizeTextarea(); }}
              placeholder="Digite uma mensagem"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </div>
          {text.trim() ? (
            <button type="submit" style={S.sendBtn} title="Enviar" aria-label="Enviar">
              <SendIcon />
            </button>
          ) : (
            <button type="button" onClick={startRecording} style={S.sendBtn} title="Gravar áudio" aria-label="Gravar áudio">
              <MicIcon />
            </button>
          )}
        </form>
      )}
    </div>
  );
}

function senderName(m: RcMessage) {
  return m.alias || m.u.name || m.u.username;
}

function sameSender(a: RcMessage, b: RcMessage, isFromVisitor: (m: RcMessage) => boolean) {
  if (isFromVisitor(a) !== isFromVisitor(b)) return false;
  if (!isFromVisitor(a) && senderName(a) !== senderName(b)) return false;
  return Math.abs(new Date(b.ts).getTime() - new Date(a.ts).getTime()) < GROUP_WINDOW_MS;
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

// Turns bare URLs into clickable links. split() with a capture group puts the
// matched URLs at the odd indices.
function linkify(text: string) {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1
      ? <a key={i} href={part} target="_blank" rel="noreferrer" className="chat-link">{part}</a>
      : part,
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
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

// Ícones inline (stroke = currentColor) — sem dependência externa
function Icon({ children, size = 20 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      {children}
    </svg>
  );
}
const SendIcon = () => <Icon><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></Icon>;
const MicIcon = () => <Icon><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><path d="M12 17v5" /></Icon>;
const PaperclipIcon = () => <Icon><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" /></Icon>;
const TrashIcon = () => <Icon><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></Icon>;
const HeadsetIcon = () => <Icon size={22}><path d="M3 14v-2a9 9 0 0 1 18 0v2" /><path d="M21 15a2 2 0 0 1-2 2h-1v-6h1a2 2 0 0 1 2 2z" /><path d="M3 15a2 2 0 0 0 2 2h1v-6H5a2 2 0 0 0-2 2z" /></Icon>;
const ChatBubbleIcon = () => <Icon size={28}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Icon>;
const FileIcon = () => <Icon size={18}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></Icon>;
const CheckIcon = () => <Icon size={14}><path d="M20 6 9 17l-5-5" /></Icon>;
const ClockIcon = () => <Icon size={13}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>;
const AlertIcon = () => <Icon size={14}><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></Icon>;
const ArrowDownIcon = () => <Icon size={16}><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></Icon>;

// Textura de fundo sutil (papel/doodle), no estilo do WhatsApp — SVG inline, sem asset externo
const CHAT_BG_PATTERN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100' viewBox='0 0 100 100'%3E%3Cg fill='%23000000' fill-opacity='0.025'%3E%3Ccircle cx='10' cy='10' r='1.5'/%3E%3Ccircle cx='50' cy='30' r='1.5'/%3E%3Ccircle cx='85' cy='15' r='1.5'/%3E%3Ccircle cx='30' cy='60' r='1.5'/%3E%3Ccircle cx='70' cy='70' r='1.5'/%3E%3Ccircle cx='15' cy='85' r='1.5'/%3E%3Ccircle cx='90' cy='90' r='1.5'/%3E%3C/g%3E%3C/svg%3E")`;

const S: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column',
    height: '100dvh', maxWidth: 720, margin: '0 auto', width: '100%',
    background: '#ECE5DD', fontFamily: 'inherit',
    boxShadow: '0 0 24px rgba(0,0,0,0.12)',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: '0.75rem',
    padding: '0.65rem 1rem', background: '#075E54', color: '#fff', flexShrink: 0,
    boxShadow: '0 2px 8px rgba(0,0,0,0.15)', zIndex: 2,
  },
  avatar: {
    width: 40, height: 40, borderRadius: '50%',
    background: 'rgba(255,255,255,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, fontWeight: 600, fontSize: '0.95rem', letterSpacing: '0.02em',
  },
  headerTitle: {
    fontWeight: 600, fontSize: '1rem', lineHeight: 1.2,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  headerSub: { fontSize: '0.75rem', opacity: 0.85, marginTop: '0.15rem', display: 'flex', alignItems: 'center', gap: '0.35rem' },
  onlineDot: { width: 7, height: 7, borderRadius: '50%', background: '#25D366', display: 'inline-block' },
  endBtn: {
    background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.25)',
    padding: '0.4rem 0.9rem', borderRadius: 999, fontSize: '0.78rem',
    fontWeight: 600, cursor: 'pointer', flexShrink: 0, fontFamily: 'inherit',
  },
  listWrap: { flex: 1, position: 'relative', minHeight: 0 },
  messageList: {
    position: 'absolute', inset: 0, overflowY: 'auto', padding: '0.5rem 4% 0.75rem',
    display: 'flex', flexDirection: 'column',
    backgroundColor: '#ECE5DD', backgroundImage: CHAT_BG_PATTERN,
  },
  empty: {
    margin: 'auto', textAlign: 'center', color: '#667781', fontSize: '0.85rem',
    background: 'rgba(255,255,255,0.85)', padding: '1.25rem 1.5rem', borderRadius: 12,
    boxShadow: '0 1px 2px rgba(0,0,0,0.08)', maxWidth: 300,
  },
  emptyIcon: {
    width: 52, height: 52, borderRadius: '50%', background: '#DCF8C6', color: '#075E54',
    display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 0.6rem',
  },
  dividerRow: { display: 'flex', justifyContent: 'center', margin: '0.75rem 0 0.25rem' },
  dividerPill: {
    background: '#E1F3FB', color: '#4a5b60', fontSize: '0.72rem', fontWeight: 500,
    padding: '0.3rem 0.75rem', borderRadius: 8, boxShadow: '0 1px 1px rgba(0,0,0,0.08)',
  },
  dividerCurrent: { background: '#FFF5C4', color: '#6b5a12' },
  row: { display: 'flex', width: '100%' },
  bubble: {
    maxWidth: 'min(78%, 520px)', padding: '0.4rem 0.6rem 0.3rem',
    borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.4,
    wordBreak: 'break-word', boxShadow: '0 1px 0.5px rgba(0,0,0,0.13)',
  },
  bubbleAgent: { background: '#fff', color: '#111b21' },
  bubbleMe: { background: '#DCF8C6', color: '#111b21' },
  senderName: {
    fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.15rem',
    color: '#075E54',
  },
  msgText: { margin: 0, whiteSpace: 'pre-wrap' },
  attach: { marginTop: '0.3rem' },
  attachImg: { maxWidth: 'min(260px, 100%)', borderRadius: 6, display: 'block', cursor: 'zoom-in' },
  attachAudio: { maxWidth: 260, width: '100%', display: 'block', height: 36 },
  fileChip: {
    display: 'flex', alignItems: 'center', gap: '0.5rem',
    background: 'rgba(0,0,0,0.05)', borderRadius: 6, padding: '0.5rem 0.65rem',
    color: 'inherit', textDecoration: 'none',
  },
  fileName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  attachDesc: { fontSize: '0.8rem', margin: '0.25rem 0 0', opacity: 0.8 },
  metaRow: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.25rem', marginTop: '0.1rem' },
  ts: { fontSize: '0.66rem', color: '#667781' },
  status: { color: '#8696a0', display: 'flex' },
  failedRow: {
    display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.2rem',
    fontSize: '0.72rem', color: '#d93025',
  },
  linkBtn: {
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    color: '#075E54', fontWeight: 600, fontSize: '0.72rem', fontFamily: 'inherit', textDecoration: 'underline',
  },
  newBelowBtn: {
    position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: '0.35rem',
    background: '#fff', color: '#075E54', border: 'none', borderRadius: 999,
    padding: '0.45rem 0.9rem', fontSize: '0.78rem', fontWeight: 600, fontFamily: 'inherit',
    boxShadow: '0 2px 8px rgba(0,0,0,0.18)', cursor: 'pointer', zIndex: 1,
  },
  recordIndicator: {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
    color: '#54656f', fontSize: '0.9rem', fontVariantNumeric: 'tabular-nums',
  },
  recordDot: {
    width: 10, height: 10, borderRadius: '50%', background: '#e53935',
    animation: 'blink 1s ease-in-out infinite',
  },
  errorBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
    background: '#fee2e2', color: '#b91c1c',
    padding: '0.5rem 1rem', fontSize: '0.85rem',
    cursor: 'pointer', flexShrink: 0,
  },
  closedBar: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem',
    background: '#F0F2F5', color: '#54656f', borderTop: '1px solid #e2e8f0',
    padding: '0.85rem 1rem calc(0.85rem + env(safe-area-inset-bottom))', fontSize: '0.85rem',
    textAlign: 'center', flexShrink: 0,
  },
  offlineNotice: {
    width: '100%', maxWidth: 420, background: '#FEF3C7', border: '1px solid #FCD34D',
    color: '#92400E', borderRadius: 10, padding: '0.6rem 0.85rem', fontSize: '0.82rem', lineHeight: 1.45,
  },
  reopenBtn: {
    background: '#075E54', color: '#fff', border: 'none',
    padding: '0.55rem 1.2rem', borderRadius: 999, fontSize: '0.85rem',
    fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },
  inputRow: {
    display: 'flex', alignItems: 'flex-end', gap: '0.5rem',
    padding: '0.5rem 0.75rem calc(0.5rem + env(safe-area-inset-bottom))', background: '#F0F2F5',
    flexShrink: 0,
  },
  composer: {
    flex: 1, display: 'flex', alignItems: 'flex-end', gap: '0.15rem', minWidth: 0,
    background: '#fff', borderRadius: 22, padding: '0.2rem 0.4rem',
    boxShadow: '0 1px 1px rgba(0,0,0,0.08)',
  },
  textInput: {
    flex: 1, border: 'none', resize: 'none', outline: 'none', background: 'transparent',
    padding: '0.5rem 0.4rem', fontSize: '0.95rem', lineHeight: 1.35, fontFamily: 'inherit',
    color: '#111b21', minWidth: 0, maxHeight: TEXTAREA_MAX_HEIGHT, overflowY: 'auto',
  },
  iconBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '0.45rem', borderRadius: '50%', flexShrink: 0,
    color: '#54656f', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  sendBtn: {
    background: '#00A884', color: '#fff', border: 'none', cursor: 'pointer',
    borderRadius: '50%', width: 44, height: 44, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
  },
  spinner: {
    width: 18, height: 18, borderRadius: '50%', display: 'block',
    border: '2px solid #cfd6da', borderTopColor: '#00A884',
    animation: 'spin 0.8s linear infinite',
  },
};
