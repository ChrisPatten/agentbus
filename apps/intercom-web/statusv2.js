// Agent Status v2: pure model for the session list, the rim segments and the conversation messages.
import { deskStateColor, ringSegments, ageText, sessionNeedsYou } from './logic.js';

export const RING_CAP = 8;
export const VISIBLE_ROWS = 4;
export const NEEDS_COLOR = '#ffb347';

/** Sessions from the v1 `desk` payload in the v2 shape (the fallback when the bus has no sessions resource). */
export function sessionsFromDesk(desk) {
  return ((desk && desk.sessions) || []).map((s) => ({
    id: s.id, title: s.title, subject: null, state: s.state, channel: s.channel || '', conversation_id: null,
    since: s.since, last_activity_at: s.since, needs_you: sessionNeedsYou(s), needs_you_message_id: null, system: false,
  }));
}

/** v2 sessions in the order the server sent them (needs_you first). */
export function sessionsFromStore(store) {
  return Object.values((store && store.items.sessions) || {});
}

export const sessionColor = (s) => (s.needs_you ? NEEDS_COLOR : deskStateColor(s.state));

/**
 * The status face model: one row per session, a rim segment per session for the first RING_CAP and a "+N" marker beyond,
 * and `needs` when any session needs you (the rim breathes). The server's order is kept.
 */
export function statusModel(sessions, nowMs) {
  const list = sessions || [];
  const rows = list.map((s) => ({
    id: s.id, name: s.subject || s.title || 'Session', color: sessionColor(s), needs: !!s.needs_you, state: s.state,
    age: ageText(s.last_activity_at || s.since, nowMs), conversationId: s.conversation_id || null,
  }));
  const shown = rows.slice(0, RING_CAP);
  const segs = ringSegments(shown.length).map((g, i) => ({ ...g, color: shown[i].color, id: shown[i].id }));
  return { rows, segs, more: Math.max(0, rows.length - RING_CAP), needs: rows.some((r) => r.needs) };
}

/* ---------- conversation messages ---------- */

/** Merge an older page (chronological) in front of the held messages, dropping duplicates. */
export function mergeOlder(held, page) {
  const ids = new Set(held.map((m) => m.id));
  return [...page.filter((m) => !ids.has(m.id)), ...held];
}

/** Append one live message; a repeat id is ignored. Returns whether it was added. */
export function appendMessage(held, msg) {
  if (!msg || !msg.id || held.some((m) => m.id === msg.id)) return false;
  held.push(msg);
  return true;
}

/** Roles shown as bubbles: Chris on the right, the agent on the left. */
export const bubbleSide = (m) => (m.role === 'user' ? 'me' : 'them');
