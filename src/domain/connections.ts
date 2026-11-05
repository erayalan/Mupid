import type { DatabaseSync } from 'node:sqlite';
import { Store, type ProposalRow } from '../db/store.js';
import { utcNow } from '../db/database.js';
import { MupitError, notFound, validation, versionConflict } from './errors.js';
import { recheckPair } from './conversations.js';
import { CHANNELS, type Channel } from './schemas.js';
import type { ContactVault } from '../security/contact-vault.js';

export type ApprovalProvenance = 'human_reported_by_personal_agent' | 'simulated_fixture';

interface ApprovalEntry {
  approved: boolean;
  at: string;
  provenance: ApprovalProvenance;
}
type Approvals = Record<string, ApprovalEntry>;

function parseApprovals(row: ProposalRow): Approvals {
  return JSON.parse(row.approvals_json) as Approvals;
}

function requireHumanConfirmed(humanConfirmed: boolean, what: string): void {
  if (humanConfirmed !== true) {
    throw new MupitError('CONSENT_REQUIRED', `${what} requires explicit human confirmation (human_confirmed=true). An agent recommendation is not consent.`);
  }
}

function validateContactValue(channel: Channel, value: string): string {
  const v = value.trim();
  if (v.length === 0 || v.length > 320) throw validation('Contact value must be 1-320 characters.');
  if (channel === 'email') {
    if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(v)) throw validation('Invalid email address for channel "email".');
  } else if (channel === 'instagram') {
    if (!/^@?[\w.]{1,30}$/.test(v)) throw validation('Invalid Instagram handle: 1-30 letters, numbers, underscores, dots.');
  } else if (channel === 'phone') {
    if (!/^\+?[0-9][0-9\s().-]{5,20}$/.test(v)) throw validation('Invalid phone number for channel "phone".');
  }
  return v;
}

function bothApproved(convIds: [string, string], approvals: Approvals): boolean {
  return convIds.every((pid) => approvals[pid]?.approved === true);
}

function proposalView(store: Store, row: ProposalRow): Record<string, unknown> {
  const subs = store.listSubmissions(row.conversation_id, row.version);
  const submittedBy = new Set(subs.map((s) => s.participant_id));
  const conv = store.getConversation(row.conversation_id);
  return {
    conversation_id: row.conversation_id,
    version: row.version,
    channel: row.channel,
    proposer_id: row.proposer_id,
    approvals: parseApprovals(row),
    status: row.status,
    contact_submitted: conv ? { [conv.a_id]: submittedBy.has(conv.a_id), [conv.b_id]: submittedBy.has(conv.b_id) } : {},
  };
}

export function proposeConnection(
  db: DatabaseSync,
  callerId: string,
  conversationId: string,
  expectedVersion: number,
  channel: Channel,
  humanConfirmed: boolean,
  provenance: ApprovalProvenance,
): Record<string, unknown> {
  if (!CHANNELS.includes(channel)) throw validation(`Unsupported channel "${channel}". Supported: email, instagram, phone.`);
  requireHumanConfirmed(humanConfirmed, 'A connection proposal');
  const store = new Store(db);
  return store.transaction(() => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw notFound('conversation');
    if (conv.a_id !== callerId && conv.b_id !== callerId) throw notFound('conversation');
    if (conv.status === 'closed') throw new MupitError('CONVERSATION_CLOSED', 'This conversation is closed.');
    if (conv.status === 'released') throw new MupitError('CONVERSATION_RELEASED', 'Contact for this introduction was already released.');
    const other = conv.a_id === callerId ? conv.b_id : conv.a_id;
    recheckPair(store, callerId, other);

    const existing = store.getProposal(conversationId);
    const now = utcNow();
    if (!existing) {
      if (expectedVersion !== 0) throw versionConflict(`No proposal exists yet; expected_version must be 0, got ${expectedVersion}.`);
      const approvals: Approvals = { [callerId]: { approved: true, at: now, provenance } };
      store.upsertProposal({
        conversation_id: conv.id, version: 1, channel, proposer_id: callerId,
        approvals_json: JSON.stringify(approvals), status: 'negotiating',
      });
      store.emitEvent(other, 'proposal.updated', { conversation_id: conv.id, version: 1, channel, status: 'negotiating', awaiting: other });
      const revision = store.bumpRevision(conv.id);
      const row = store.getProposal(conv.id)!;
      return { ...proposalView(store, row), revision };
    }
    if (existing.status === 'released') throw new MupitError('CONVERSATION_RELEASED', 'Contact for this introduction was already released.');
    if (existing.status === 'closed') throw new MupitError('CONVERSATION_CLOSED', 'This proposal is closed.');
    if (existing.version !== expectedVersion) {
      throw versionConflict(`Stale proposal version: expected ${expectedVersion}, current is ${existing.version}.`, { current_version: existing.version });
    }
    if (existing.channel === channel) {
      // Same-channel propose = (re)approval of the current version.
      const approvals = parseApprovals(existing);
      approvals[callerId] = { approved: true, at: now, provenance };
      const status = bothApproved([conv.a_id, conv.b_id], approvals) ? 'awaiting_contacts' : 'negotiating';
      store.upsertProposal({ ...existing, approvals_json: JSON.stringify(approvals), status });
      const awaiting = [conv.a_id, conv.b_id].filter((pid) => approvals[pid]?.approved !== true);
      store.emitEvent(other, 'proposal.updated', { conversation_id: conv.id, version: existing.version, channel, status, awaiting });
      const revision = store.bumpRevision(conv.id);
      const row = store.getProposal(conv.id)!;
      return { ...proposalView(store, row), revision };
    }
    // Counter-proposal: new version, invalidate approvals AND pending submissions.
    store.deletePendingSubmissions(conv.id);
    const approvals: Approvals = { [callerId]: { approved: true, at: now, provenance } };
    store.upsertProposal({
      conversation_id: conv.id, version: existing.version + 1, channel, proposer_id: callerId,
      approvals_json: JSON.stringify(approvals), status: 'negotiating',
    });
    store.emitEvent(other, 'proposal.updated', {
      conversation_id: conv.id, version: existing.version + 1, channel, status: 'negotiating',
      awaiting: other, countered_from: existing.channel,
    });
    const revision = store.bumpRevision(conv.id);
    const row = store.getProposal(conv.id)!;
    return { ...proposalView(store, row), revision };
  });
}

export type RespondDecision = 'accept' | 'decline' | 'revoke';

export function respondConnection(
  db: DatabaseSync,
  callerId: string,
  conversationId: string,
  proposalVersion: number,
  decision: RespondDecision,
  humanConfirmed: boolean,
  provenance: ApprovalProvenance,
): Record<string, unknown> {
  if (!['accept', 'decline', 'revoke'].includes(decision)) throw validation(`Invalid decision "${decision}".`);
  requireHumanConfirmed(humanConfirmed, `A connection ${decision}`);
  const store = new Store(db);
  return store.transaction(() => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw notFound('conversation');
    if (conv.a_id !== callerId && conv.b_id !== callerId) throw notFound('conversation');
    const other = conv.a_id === callerId ? conv.b_id : conv.a_id;
    const existing = store.getProposal(conversationId);
    if (!existing) throw notFound('connection proposal');
    if (existing.status === 'released') throw new MupitError('CONVERSATION_RELEASED', 'Contact for this introduction was already released.');
    if (existing.status === 'closed' || conv.status === 'closed') throw new MupitError('CONVERSATION_CLOSED', 'This proposal is closed.');
    if (existing.version !== proposalVersion) {
      throw versionConflict(`Stale proposal version: expected ${proposalVersion}, current is ${existing.version}.`, { current_version: existing.version });
    }
    const now = utcNow();
    if (decision === 'decline') {
      store.deletePendingSubmissions(conv.id);
      store.upsertProposal({ ...existing, status: 'closed' });
      const revision = store.setConversationStatus(conv.id, 'closed');
      for (const pid of [callerId, other]) {
        store.emitEvent(pid, 'proposal.updated', { conversation_id: conv.id, version: existing.version, status: 'closed', decided_by: callerId, decision: 'decline' });
        store.emitEvent(pid, 'conversation.closed', { conversation_id: conv.id, closed_by: callerId });
      }
      return { conversation_id: conv.id, version: existing.version, status: 'closed', revision };
    }
    if (decision === 'revoke') {
      const approvals = parseApprovals(existing);
      delete approvals[callerId];
      store.deletePendingSubmissions(conv.id);
      store.upsertProposal({ ...existing, approvals_json: JSON.stringify(approvals), status: 'negotiating' });
      store.emitEvent(other, 'proposal.updated', { conversation_id: conv.id, version: existing.version, channel: existing.channel, status: 'negotiating', awaiting: callerId, revoked_by: callerId });
      const revision = store.bumpRevision(conv.id);
      const row = store.getProposal(conv.id)!;
      return { ...proposalView(store, row), revision };
    }
    // accept
    recheckPair(store, callerId, other);
    const approvals = parseApprovals(existing);
    approvals[callerId] = { approved: true, at: now, provenance };
    const status = bothApproved([conv.a_id, conv.b_id], approvals) ? 'awaiting_contacts' : 'negotiating';
    store.upsertProposal({ ...existing, approvals_json: JSON.stringify(approvals), status });
    const awaiting = [conv.a_id, conv.b_id].filter((pid) => approvals[pid]?.approved !== true);
    store.emitEvent(other, 'proposal.updated', { conversation_id: conv.id, version: existing.version, channel: existing.channel, status, awaiting });
    const revision = store.bumpRevision(conv.id);
    const row = store.getProposal(conv.id)!;
    return { ...proposalView(store, row), revision };
  });
}

export function submitContact(
  db: DatabaseSync,
  vault: ContactVault,
  callerId: string,
  conversationId: string,
  proposalVersion: number,
  channel: Channel,
  value: string,
  humanConfirmed: boolean,
  provenance: ApprovalProvenance,
): Record<string, unknown> {
  if (!CHANNELS.includes(channel)) throw validation(`Unsupported channel "${channel}".`);
  requireHumanConfirmed(humanConfirmed, 'Contact submission');
  const clean = validateContactValue(channel, value);
  const store = new Store(db);
  return store.transaction(() => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw notFound('conversation');
    if (conv.a_id !== callerId && conv.b_id !== callerId) throw notFound('conversation');
    if (conv.status === 'closed') throw new MupitError('CONVERSATION_CLOSED', 'This conversation is closed.');
    if (conv.status === 'released') throw new MupitError('CONVERSATION_RELEASED', 'Contact for this introduction was already released.');
    const other = conv.a_id === callerId ? conv.b_id : conv.a_id;
    recheckPair(store, callerId, other);
    const proposal = store.getProposal(conversationId);
    if (!proposal) throw new MupitError('CONSENT_REQUIRED', 'No connection proposal exists for this conversation yet.');
    if (proposal.status === 'released') throw new MupitError('CONVERSATION_RELEASED', 'Contact was already released.');
    if (proposal.status === 'closed') throw new MupitError('CONVERSATION_CLOSED', 'This proposal is closed.');
    if (proposal.version !== proposalVersion) {
      throw versionConflict(`Stale proposal version: expected ${proposalVersion}, current is ${proposal.version}. Re-approve the current version first.`, {
        current_version: proposal.version,
      });
    }
    if (proposal.channel !== channel) {
      throw validation(`Channel mismatch: proposal is "${proposal.channel}", submission is "${channel}". The channel must be the same for both parties.`);
    }
    const approvals = parseApprovals(proposal);
    if (approvals[callerId]?.approved !== true) {
      throw new MupitError('CONSENT_REQUIRED', 'You have not approved the current proposal version. Approve it before submitting contact.');
    }
    store.insertSubmission({
      conversation_id: conv.id, proposal_version: proposal.version, participant_id: callerId,
      channel, sealed_value: vault.seal(clean), key_id: vault.keyId, consent_at: utcNow(), provenance,
    });
    store.emitEvent(other, 'contact.submitted', {
      conversation_id: conv.id, version: proposal.version, submitted_by: callerId,
      awaiting: store.getSubmission(conv.id, proposal.version, other) ? null : other,
    });
    // Atomic release check: both current approvals + both current submissions.
    const subs = store.listSubmissions(conv.id, proposal.version);
    const haveBoth = [conv.a_id, conv.b_id].every((pid) => subs.some((s) => s.participant_id === pid));
    if (bothApproved([conv.a_id, conv.b_id], approvals) && haveBoth) {
      store.upsertProposal({ ...proposal, status: 'released' });
      const revision = store.setConversationStatus(conv.id, 'released');
      for (const pid of [conv.a_id, conv.b_id]) {
        store.emitEvent(pid, 'connection.released', {
          conversation_id: conv.id, version: proposal.version, channel,
          note: 'Both sides approved and submitted. Read the counterpart contact with mupit_get_connection_contact.',
        });
      }
      return { conversation_id: conv.id, version: proposal.version, contact_submitted: true, released: true, revision };
    }
    const revision = store.bumpRevision(conv.id);
    return {
      conversation_id: conv.id, version: proposal.version, contact_submitted: true, released: false,
      awaiting_counterpart_contact: !store.getSubmission(conv.id, proposal.version, other), revision,
      note: 'Your contact is stored privately. It is released only after the other side also submits for this same version.',
    };
  });
}

export function getConnectionContact(
  db: DatabaseSync,
  vault: ContactVault,
  callerId: string,
  conversationId: string,
  proposalVersion: number,
): Record<string, unknown> {
  const store = new Store(db);
  const conv = store.getConversation(conversationId);
  if (!conv) throw notFound('conversation');
  if (conv.a_id !== callerId && conv.b_id !== callerId) throw notFound('conversation');
  const other = conv.a_id === callerId ? conv.b_id : conv.a_id;
  if (store.isBlockedPair(callerId, other)) {
    throw new MupitError('CONTACT_NOT_RELEASED', 'Contact is not available for this pair.');
  }
  const proposal = store.getProposal(conversationId);
  if (!proposal || proposal.status !== 'released' || proposal.version !== proposalVersion) {
    throw new MupitError('CONTACT_NOT_RELEASED', 'Contact has not been mutually released for this proposal version.');
  }
  const sub = store.getSubmission(conversationId, proposal.version, other);
  if (!sub) throw new MupitError('CONTACT_NOT_RELEASED', 'Contact has not been mutually released for this proposal version.');
  let value: string;
  try {
    value = vault.open(sub.sealed_value);
  } catch (err) {
    throw new MupitError('INTERNAL_ERROR', 'Contact vault is unavailable (key mismatch). Data is preserved; fix the vault key.', undefined, true);
  }
  return {
    conversation_id: conv.id, version: proposal.version, channel: proposal.channel,
    counterpart_participant_id: other, contact_value: value,
    note: 'This contact was approved for release by its owner for this introduction. Handle it with care.',
  };
}
