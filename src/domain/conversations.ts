import type { DatabaseSync } from 'node:sqlite';
import type { MupitConfig } from '../config.js';
import { Store, parseIntro, parsePrefs, type ConversationRow } from '../db/store.js';
import { MupitError, notFound, validation } from './errors.js';
import { checkEligibility } from './discovery.js';
import { detectIdentifiers } from './identifiers.js';
import { ASSESSMENTS, MESSAGE_KINDS, type Assessment, type MessageKind } from './schemas.js';
import { randomId } from '../security/tokens.js';

export interface MessageView {
  message_id: string;
  seq: number;
  sender_role: 'personal_agent' | 'mupit';
  sender_participant_id: string | null;
  addressed_participant_ids: string[];
  kind: MessageKind;
  body: string;
  evidence_refs?: string[];
  created_at: string;
}

function requireMember(conv: ConversationRow, callerId: string): 'a' | 'b' {
  if (conv.a_id === callerId) return 'a';
  if (conv.b_id === callerId) return 'b';
  throw notFound('conversation');
}

function counterpartOf(conv: ConversationRow, callerId: string): string {
  requireMember(conv, callerId);
  return conv.a_id === callerId ? conv.b_id : conv.a_id;
}

function toMessageView(row: {
  id: string; seq: number; sender_role: string; sender_participant_id: string | null;
  addressed_ids_json: string; kind: string; body: string; evidence_json: string | null; created_at: string;
}): MessageView {
  return {
    message_id: row.id,
    seq: row.seq,
    sender_role: row.sender_role as 'personal_agent' | 'mupit',
    sender_participant_id: row.sender_participant_id,
    addressed_participant_ids: JSON.parse(row.addressed_ids_json) as string[],
    kind: row.kind as MessageKind,
    body: row.body,
    ...(row.evidence_json ? { evidence_refs: JSON.parse(row.evidence_json) as string[] } : {}),
    created_at: row.created_at,
  };
}

/** Recheck blocks + current-version eligibility. Throws INELIGIBLE_PAIR / NOT_FOUND. */
export function recheckPair(store: Store, aId: string, bId: string): void {
  if (store.isBlockedPair(aId, bId)) throw notFound('conversation');
  const a = store.getParticipantById(aId);
  const b = store.getParticipantById(bId);
  if (!a || !b || a.is_active !== 1 || b.is_active !== 1) {
    throw new MupitError('INELIGIBLE_PAIR', 'This pair is no longer eligible (participant paused or missing).');
  }
  const verdict = checkEligibility(parseIntro(a), parsePrefs(a), parseIntro(b), parsePrefs(b));
  if (!verdict.eligible) {
    throw new MupitError('INELIGIBLE_PAIR', `This pair no longer satisfies reciprocal requirements: ${verdict.reasons.join(' ')}`, {
      reasons: verdict.reasons,
      needs_clarification: verdict.needsClarification,
    });
  }
}

export interface OpenConversationInput {
  target_participant_id: string;
  kind: MessageKind;
  body: string;
}

export function openConversation(db: DatabaseSync, cfg: MupitConfig, callerId: string, input: OpenConversationInput): Record<string, unknown> {
  if (!MESSAGE_KINDS.includes(input.kind)) throw validation(`Invalid message kind "${input.kind}".`);
  const body = input.body.trim();
  if (body.length === 0 || body.length > cfg.maxMessageChars) throw validation(`Message body must be 1-${cfg.maxMessageChars} characters.`);
  const hits = detectIdentifiers(body);
  if (hits.length > 0) throw validation(`Opening message appears to contain identifying contact info (${hits.join(', ')}). Discuss channels by name only; submit values via mupit_submit_contact.`);
  if (input.target_participant_id === callerId) throw validation('You cannot open a conversation with yourself.');

  const store = new Store(db);
  return store.transaction(() => {
    const me = store.getParticipantById(callerId);
    const target = store.getParticipantById(input.target_participant_id);
    if (!me || !target) throw notFound('participant');
    if (me.is_active !== 1) throw new MupitError('INELIGIBLE_PAIR', 'Your profile is paused. Resume with mupit_set_active before starting new introductions.');
    recheckPair(store, callerId, target.id);

    const existing = store.getConversationForPair(callerId, target.id);
    if (existing) {
      if (existing.status !== 'active') {
        throw new MupitError('CONVERSATION_CLOSED', 'This pair is closed and cannot be reopened. Blocking/closure is final for this pair.');
      }
      const seq = store.nextMessageSeq(existing.id);
      const mid = randomId('m');
      store.insertMessage({
        id: mid, conversation_id: existing.id, seq, sender_role: 'personal_agent',
        sender_participant_id: callerId, addressed_ids_json: JSON.stringify([target.id]),
        kind: input.kind, body, evidence_json: null,
      });
      const revision = store.bumpRevision(existing.id);
      store.emitEvent(target.id, 'message.created', {
        conversation_id: existing.id, message_id: mid, seq, sender_role: 'personal_agent',
        sender_participant_id: callerId, addressed_participant_ids: [target.id], kind: input.kind, body,
      });
      return { conversation_id: existing.id, created: false, message_id: mid, revision, facilitation_available: revision > existing.facil_last_input_rev };
    }

    const [a, b] = callerId < target.id ? [callerId, target.id] : [target.id, callerId];
    const convId = randomId('c');
    try {
      store.insertConversation({ id: convId, a_id: a, b_id: b, status: 'active', revision: 1, facil_last_input_rev: 0 });
    } catch (err) {
      // Simultaneous A->B and B->A initiation: unique pair constraint collapses to one thread.
      const raced = store.getConversationForPair(callerId, target.id);
      if (raced && raced.status === 'active') {
        return { conversation_id: raced.id, created: false, raced: true, revision: raced.revision, facilitation_available: true };
      }
      throw err;
    }
    const mid = randomId('m');
    store.insertMessage({
      id: mid, conversation_id: convId, seq: 1, sender_role: 'personal_agent',
      sender_participant_id: callerId, addressed_ids_json: JSON.stringify([target.id]),
      kind: input.kind, body, evidence_json: null,
    });
    const revision = store.bumpRevision(convId);
    store.emitEvent(target.id, 'message.created', {
      conversation_id: convId, message_id: mid, seq: 1, sender_role: 'personal_agent',
      sender_participant_id: callerId, addressed_participant_ids: [target.id], kind: input.kind, body,
    });
    return { conversation_id: convId, created: true, message_id: mid, revision, facilitation_available: true };
  });
}

export interface SendMessageInput {
  conversation_id: string;
  kind: MessageKind;
  body: string;
}

export function sendMessage(db: DatabaseSync, cfg: MupitConfig, callerId: string, input: SendMessageInput): Record<string, unknown> {
  if (!MESSAGE_KINDS.includes(input.kind)) throw validation(`Invalid message kind "${input.kind}".`);
  const body = input.body.trim();
  if (body.length === 0 || body.length > cfg.maxMessageChars) throw validation(`Message body must be 1-${cfg.maxMessageChars} characters.`);
  const hits = detectIdentifiers(body);
  if (hits.length > 0) throw validation(`Message appears to contain identifying contact info (${hits.join(', ')}). Discuss channels by name only; submit values via mupit_submit_contact.`);
  const store = new Store(db);
  return store.transaction(() => {
    const conv = store.getConversation(input.conversation_id);
    if (!conv) throw notFound('conversation');
    const other = counterpartOf(conv, callerId);
    if (conv.status === 'closed') throw new MupitError('CONVERSATION_CLOSED', 'This conversation is closed; no further matchmaking messages are accepted.');
    if (conv.status === 'released') throw new MupitError('CONVERSATION_RELEASED', 'Contact for this introduction was already released; matchmaking here has ended.');
    if (store.isBlockedPair(callerId, other)) throw notFound('conversation');
    const seq = store.nextMessageSeq(conv.id);
    const mid = randomId('m');
    store.insertMessage({
      id: mid, conversation_id: conv.id, seq, sender_role: 'personal_agent',
      sender_participant_id: callerId, addressed_ids_json: JSON.stringify([other]),
      kind: input.kind, body, evidence_json: null,
    });
    const revision = store.bumpRevision(conv.id);
    store.emitEvent(other, 'message.created', {
      conversation_id: conv.id, message_id: mid, seq, sender_role: 'personal_agent',
      sender_participant_id: callerId, addressed_participant_ids: [other], kind: input.kind, body,
    });
    return { conversation_id: conv.id, message_id: mid, seq, revision, facilitation_available: revision > conv.facil_last_input_rev };
  });
}

export function readConversation(
  db: DatabaseSync, callerId: string, conversationId: string, afterSeq: number, limit: number,
): Record<string, unknown> {
  const store = new Store(db);
  const conv = store.getConversation(conversationId);
  if (!conv) throw notFound('conversation');
  const other = counterpartOf(conv, callerId);
  const me = store.getParticipantById(callerId);
  const them = store.getParticipantById(other);
  if (!me || !them) throw notFound('conversation');
  const rows = store.listMessages(conversationId, afterSeq, limit);
  const proposal = store.getProposal(conversationId);
  const myAssessment = store.getAssessment(conversationId, callerId);
  const theirAssessment = store.getAssessment(conversationId, other);
  const submissions = proposal ? store.listSubmissions(conversationId, proposal.version) : [];
  const submittedBy = new Set(submissions.map((s) => s.participant_id));
  return {
    conversation_id: conv.id,
    status: conv.status,
    revision: conv.revision,
    facil_last_input_rev: conv.facil_last_input_rev,
    facilitation_available: conv.revision > conv.facil_last_input_rev && conv.status === 'active',
    participants: [
      { participant_id: me.id, introduction: parseIntro(me), preferences: parsePrefs(me), introduction_version: me.version },
      { participant_id: them.id, introduction: parseIntro(them), preferences: parsePrefs(them), introduction_version: them.version },
    ],
    messages: rows.map(toMessageView),
    my_assessment: myAssessment ?? null,
    their_assessment: theirAssessment ?? null,
    connection_proposal: proposal
      ? {
          version: proposal.version, channel: proposal.channel, proposer_id: proposal.proposer_id,
          approvals: JSON.parse(proposal.approvals_json) as Record<string, unknown>,
          status: proposal.status,
          contact_submitted: { [conv.a_id]: submittedBy.has(conv.a_id), [conv.b_id]: submittedBy.has(conv.b_id) },
        }
      : null,
  };
}

export function listConversations(db: DatabaseSync, callerId: string, status: string | undefined, cursor: string | undefined, limit: number): Record<string, unknown> {
  const store = new Store(db);
  let convs = store.listConversationsFor(callerId);
  if (status) convs = convs.filter((c) => c.status === status);
  if (cursor) convs = convs.filter((c) => c.id > cursor);
  const page = convs.slice(0, limit);
  const items = page.map((conv) => {
    const other = conv.a_id === callerId ? conv.b_id : conv.a_id;
    const recent = store.recentMessages(conv.id, 1)[0];
    const proposal = store.getProposal(conv.id);
    const myAssessment = store.getAssessment(conv.id, callerId);
    const awaitingMe = !!recent && recent.sender_role === 'personal_agent' && recent.sender_participant_id !== callerId;
    const mupitWaiting = !!recent && recent.sender_role === 'mupit' && (JSON.parse(recent.addressed_ids_json) as string[]).includes(callerId);
    return {
      conversation_id: conv.id,
      counterpart_id: other,
      status: conv.status,
      revision: conv.revision,
      facilitation_available: conv.revision > conv.facil_last_input_rev && conv.status === 'active',
      awaiting_my_reply: awaitingMe || mupitWaiting,
      last_message: recent ? { seq: recent.seq, sender_role: recent.sender_role, kind: recent.kind, preview: recent.body.slice(0, 200) } : null,
      my_assessment: myAssessment?.assessment ?? null,
      connection_proposal: proposal ? { version: proposal.version, channel: proposal.channel, status: proposal.status } : null,
    };
  });
  return {
    conversations: items,
    next_cursor: convs.length > limit ? page[page.length - 1]!.id : null,
  };
}

export function setAssessment(
  db: DatabaseSync, callerId: string, conversationId: string, assessment: Assessment, rationale: string,
): Record<string, unknown> {
  if (!ASSESSMENTS.includes(assessment)) throw validation(`Invalid assessment "${assessment}".`);
  const r = rationale.trim().slice(0, 500);
  if (r.length === 0) throw validation('A concise rationale is required.');
  const store = new Store(db);
  return store.transaction(() => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw notFound('conversation');
    const other = counterpartOf(conv, callerId);
    if (conv.status !== 'active') throw new MupitError('CONVERSATION_CLOSED', 'Assessments can only be updated on active conversations.');
    store.upsertAssessment(conv.id, callerId, assessment, r);
    const revision = store.bumpRevision(conv.id);
    store.emitEvent(other, 'assessment.updated', { conversation_id: conv.id, participant_id: callerId, assessment });
    return { conversation_id: conv.id, assessment, revision, note: 'An agent assessment is an opinion, not human consent. It never authorizes contact release.' };
  });
}

export function closeConversation(db: DatabaseSync, callerId: string, conversationId: string): Record<string, unknown> {
  const store = new Store(db);
  return store.transaction(() => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw notFound('conversation');
    const other = counterpartOf(conv, callerId);
    if (conv.status === 'closed') return { conversation_id: conv.id, status: 'closed', already: true };
    const proposal = store.getProposal(conv.id);
    store.deletePendingSubmissions(conv.id);
    if (proposal && proposal.status !== 'released') {
      store.upsertProposal({ ...proposal, status: 'closed' });
    }
    const revision = store.setConversationStatus(conv.id, 'closed');
    for (const pid of [callerId, other]) {
      store.emitEvent(pid, 'conversation.closed', { conversation_id: conv.id, closed_by: callerId });
    }
    return { conversation_id: conv.id, status: 'closed', revision };
  });
}

export function blockParticipant(db: DatabaseSync, callerId: string, targetId: string): Record<string, unknown> {
  if (targetId === callerId) throw validation('You cannot block yourself.');
  const store = new Store(db);
  return store.transaction(() => {
    store.insertBlock(callerId, targetId);
    const conv = store.getConversationForPair(callerId, targetId);
    if (conv && conv.status !== 'closed') {
      const proposal = store.getProposal(conv.id);
      store.deletePendingSubmissions(conv.id);
      if (proposal && proposal.status !== 'released') {
        store.upsertProposal({ ...proposal, status: 'closed' });
      }
      store.setConversationStatus(conv.id, 'closed');
      for (const pid of [conv.a_id, conv.b_id]) {
        store.emitEvent(pid, 'conversation.closed', { conversation_id: conv.id, closed_by: callerId, reason: 'blocked' });
      }
    }
    return {
      blocked_participant_id: targetId,
      note: 'Blocking prevents discovery, messages, proposals, and future contact reads between this pair. Information already disclosed cannot be recalled.',
    };
  });
}
