import { queueState } from './queueState';
import { fetchAgentsOnline, openRoom, sendInfoAgent } from './rocketchatApi';

// RC refuses to open a room while no agent is online (no-agent-online). Rather
// than turning the visitor away, /visitors/register and /visitors/reopen park
// them here as 'pending' — they see their place in line like anyone else —
// and this job keeps retrying until RC accepts the room.

const RETRY_INTERVAL_MS = parseInt(process.env.PENDING_RETRY_SECONDS ?? '15', 10) * 1000;
// Give up on a visitor nobody could serve for this long, instead of opening a
// room days later for someone who's long gone.
const PENDING_TTL_MS = parseFloat(process.env.PENDING_TTL_HOURS ?? '12') * 60 * 60 * 1000;

// Called once RC opened a room for a pending visitor (by this job, or by a
// repeat register/reopen call): moves them into the regular queue without
// losing their place, and posts the bot's infoagent if the room is new.
export async function promotePending(visitorToken: string, roomId: string, newRoom: boolean): Promise<void> {
  const entry = queueState.getEntry(visitorToken);
  if (entry?.status !== 'pending') return;
  const infoagent = entry.pending?.infoagent;
  // No createdAt: an existing entry keeps its enteredAt, i.e. its place in line.
  queueState.enqueue(roomId, visitorToken, entry.departmentId);
  if (infoagent && newRoom) await sendInfoAgent(visitorToken, roomId, infoagent);
}

let running = false;

export async function retryPendingRooms(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const entry of queueState.getPendingEntries()) {
      const token = entry.visitorToken;

      if (Date.now() - entry.enteredAt > PENDING_TTL_MS) {
        console.log(`[pending] expired after ${PENDING_TTL_MS / 3_600_000}h token=${token.slice(0, 12)}...`);
        queueState.removePending(token);
        continue;
      }

      // Cheap, cached check first — skip the room attempt while RC says
      // nobody's online. null (unknown) still tries.
      if (await fetchAgentsOnline(entry.departmentId || undefined) === false) continue;

      try {
        const { roomId, newRoom, errorType } = await openRoom(token);
        if (!roomId) {
          if (errorType !== 'no-agent-online') console.warn(`[pending] openRoom failed token=${token.slice(0, 12)}... errorType=${errorType}`);
          continue;
        }
        console.log(`[pending] room opened roomId=${roomId} new=${newRoom} token=${token.slice(0, 12)}...`);
        await promotePending(token, roomId, newRoom);
      } catch (err) {
        console.error(`[pending] retry error token=${token.slice(0, 12)}...`, err);
      }
    }
  } finally {
    running = false;
  }
}

export function startPendingQueueJob(): void {
  setInterval(retryPendingRooms, RETRY_INTERVAL_MS);
  console.log(`[pending] retry job started (every ${RETRY_INTERVAL_MS / 1000}s)`);
}
