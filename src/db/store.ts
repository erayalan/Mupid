import type { DatabaseSync } from 'node:sqlite';
import { utcNow } from './database.js';
import type { Introduction, Preferences } from '../domain/schemas.js';

export interface ParticipantRow {
  id: string;
  token_hash: string;
  reg_key_hash: string;
  reg_payload_hash: string;
  intro_json: string;
  prefs_json: string;
  version: number;
  is_active: number;
  is_simulated: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: string;
  a_id: string;
  b_id: string;
  status: string;
  revision: number;
  facil_last_input_rev: number;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  sender_role: string;
  sender_participant_id: string | null;
  addressed_ids_json: string;
  kind: string;
  body: string;
  evidence_json: string | null;
  created_at: string;
}

export interface ProposalRow {
  conversation_id: string;
  version: number;
  channel: string;
  proposer_id: string;
  approvals_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SubmissionRow {
  conversation_id: string;
  proposal_version: number;
  participant_id: string;
  channel: string;
  sealed_value: string;
  key_id: string;
  consent_at: string;
  provenance: string;
}

export interface EventRow {
  id: number;
  recipient_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export interface FacilitatorRunRow {
  id: string;
  conversation_id: string;
  input_rev: number;
  context_hash: string;
  status: string;
  lease_expires_at: string;
  prompt_version: string;
  model_id: string;
  action: string | null;
  message_id: string | null;
  latency_ms: number | null;
  usage_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function parseIntro(row: ParticipantRow): Introduction {
  return JSON.parse(row.intro_json) as Introduction;
}
export function parsePrefs(row: ParticipantRow): Preferences {
  return JSON.parse(row.prefs_json) as Preferences;
}

/** Canonical JSON for payload hashing (stable key order, no whitespace). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Re-entrant transactions via SAVEPOINTs (depth tracked per database handle). */
const txnDepth = new WeakMap<object, number>();

/** Thin typed data-access layer. All rule checks live in domain modules. */
export class Store {
  constructor(readonly db: DatabaseSync) {}

  transaction<T>(fn: () => T): T {
    const depth = txnDepth.get(this.db) ?? 0;
    if (depth === 0) {
      txnDepth.set(this.db, 1);
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        const out = fn();
        this.db.exec('COMMIT;');
        txnDepth.set(this.db, 0);
        return out;
      } catch (err) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          /* already rolled back */
        }
        txnDepth.set(this.db, 0);
        throw err;
      }
    }
    const sp = `mupit_sp_${depth}`;
    txnDepth.set(this.db, depth + 1);
    this.db.exec(`SAVEPOINT ${sp};`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${sp};`);
      txnDepth.set(this.db, depth);
      return out;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO ${sp};`);
        this.db.exec(`RELEASE ${sp};`);
      } catch {
        /* already rolled back */
      }
      txnDepth.set(this.db, depth);
      throw err;
    }
  }

  // -- participants -------------------------------------------------------
  getParticipantById(id: string): ParticipantRow | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as ParticipantRow | undefined;
  }
  getParticipantByTokenHash(h: string): ParticipantRow | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE token_hash = ?').get(h) as ParticipantRow | undefined;
  }
  getParticipantByRegKeyHash(h: string): ParticipantRow | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE reg_key_hash = ?').get(h) as ParticipantRow | undefined;
  }
  insertParticipant(row: Omit<ParticipantRow, 'created_at' | 'updated_at'>): void {
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO participants (id, token_hash, reg_key_hash, reg_payload_hash, intro_json, prefs_json, version, is_active, is_simulated, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.token_hash, row.reg_key_hash, row.reg_payload_hash, row.intro_json, row.prefs_json, row.version, row.is_active, row.is_simulated, now, now);
  }
  updateIntroduction(id: string, introJson: string, prefsJson: string, version: number): void {
    this.db
      .prepare('UPDATE participants SET intro_json = ?, prefs_json = ?, version = ?, updated_at = ? WHERE id = ?')
      .run(introJson, prefsJson, version, utcNow(), id);
  }
  setActive(id: string, active: boolean): void {
    this.db.prepare('UPDATE participants SET is_active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, utcNow(), id);
  }
  listActiveParticipantsExcluding(excludeId: string): ParticipantRow[] {
    return this.db.prepare('SELECT * FROM participants WHERE id != ? AND is_active = 1 ORDER BY id ASC').all(excludeId) as unknown as ParticipantRow[];
  }

  // -- conversations ------------------------------------------------------
  getConversation(id: string): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  }
  getConversationForPair(a: string, b: string): ConversationRow | undefined {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.db.prepare('SELECT * FROM conversations WHERE a_id = ? AND b_id = ?').get(x, y) as ConversationRow | undefined;
  }
  insertConversation(row: Omit<ConversationRow, 'created_at' | 'updated_at'>): void {
    const now = utcNow();
    this.db
      .prepare('INSERT INTO conversations (id, a_id, b_id, status, revision, facil_last_input_rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.a_id, row.b_id, row.status, row.revision, row.facil_last_input_rev, now, now);
  }
  bumpRevision(id: string): number {
    this.db.prepare('UPDATE conversations SET revision = revision + 1, updated_at = ? WHERE id = ?').run(utcNow(), id);
    return (this.db.prepare('SELECT revision FROM conversations WHERE id = ?').get(id) as { revision: number }).revision;
  }
  setConversationStatus(id: string, status: string): number {
    this.db.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?').run(status, utcNow(), id);
    return this.bumpRevision(id);
  }
  setFacilConsumedRev(id: string, rev: number): void {
    this.db.prepare('UPDATE conversations SET facil_last_input_rev = ?, updated_at = ? WHERE id = ?').run(rev, utcNow(), id);
  }
  listConversationsFor(participantId: string): ConversationRow[] {
    return this.db
      .prepare('SELECT * FROM conversations WHERE a_id = ? OR b_id = ? ORDER BY updated_at DESC, id ASC')
      .all(participantId, participantId) as unknown as ConversationRow[];
  }

  // -- messages -----------------------------------------------------------
  nextMessageSeq(conversationId: string): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE conversation_id = ?').get(conversationId) as { m: number };
    return row.m + 1;
  }
  insertMessage(m: Omit<MessageRow, 'created_at'>): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, seq, sender_role, sender_participant_id, addressed_ids_json, kind, body, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.id, m.conversation_id, m.seq, m.sender_role, m.sender_participant_id, m.addressed_ids_json, m.kind, m.body, m.evidence_json, utcNow());
    // Enqueued in the same domain transaction as the message. Agent retries
    // replay their result and cannot enqueue or publish a duplicate.
    if (m.sender_role === 'personal_agent') {
      this.db.prepare(`INSERT INTO mediation_jobs (conversation_id, input_seq, next_attempt_at)
        VALUES (?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET input_seq=excluded.input_seq,
          status='pending', attempts=0, next_attempt_at=excluded.next_attempt_at,
          lease_expires_at=0, last_error=NULL`).run(m.conversation_id, m.seq, Date.now() + 300);
    }

  }
  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }
  listMessages(conversationId: string, afterSeq: number, limit: number): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(conversationId, afterSeq, limit) as unknown as MessageRow[];
  }
  recentMessages(conversationId: string, limit: number): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?')
      .all(conversationId, limit) as unknown as MessageRow[];
  }
  /** Latest agent-authored seq AFTER the latest mupit message (0 when mupit spoke last or never... see docs). */
  latestAgentSeqAfterLastMupit(conversationId: string): { lastMupitSeq: number; latestAgentSeq: number } {
    const m = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ? AND sender_role = 'mupit'")
      .get(conversationId) as { s: number };
    const a = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ? AND sender_role = 'personal_agent'")
      .get(conversationId) as { s: number };
    return { lastMupitSeq: m.s, latestAgentSeq: a.s };
  }

  // -- assessments --------------------------------------------------------
  getAssessment(conversationId: string, participantId: string): { assessment: string; rationale: string; updated_at: string } | undefined {
    return this.db
      .prepare('SELECT assessment, rationale, updated_at FROM assessments WHERE conversation_id = ? AND participant_id = ?')
      .get(conversationId, participantId) as { assessment: string; rationale: string; updated_at: string } | undefined;
  }
  upsertAssessment(conversationId: string, participantId: string, assessment: string, rationale: string): void {
    this.db
      .prepare(
        `INSERT INTO assessments (conversation_id, participant_id, assessment, rationale, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id, participant_id) DO UPDATE SET assessment = excluded.assessment, rationale = excluded.rationale, updated_at = excluded.updated_at`,
      )
      .run(conversationId, participantId, assessment, rationale, utcNow());
  }

  // -- proposals & contacts ----------------------------------------------
  getProposal(conversationId: string): ProposalRow | undefined {
    return this.db.prepare('SELECT * FROM connection_proposals WHERE conversation_id = ?').get(conversationId) as ProposalRow | undefined;
  }
  upsertProposal(p: Omit<ProposalRow, 'created_at' | 'updated_at'>): void {
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO connection_proposals (conversation_id, version, channel, proposer_id, approvals_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET version = excluded.version, channel = excluded.channel, proposer_id = excluded.proposer_id,
           approvals_json = excluded.approvals_json, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(p.conversation_id, p.version, p.channel, p.proposer_id, p.approvals_json, p.status, now, now);
  }
  deletePendingSubmissions(conversationId: string): void {
    this.db.prepare('DELETE FROM contact_submissions WHERE conversation_id = ?').run(conversationId);
  }
  getSubmission(conversationId: string, version: number, participantId: string): SubmissionRow | undefined {
    return this.db
      .prepare('SELECT * FROM contact_submissions WHERE conversation_id = ? AND proposal_version = ? AND participant_id = ?')
      .get(conversationId, version, participantId) as SubmissionRow | undefined;
  }
  listSubmissions(conversationId: string, version: number): SubmissionRow[] {
    return this.db
      .prepare('SELECT * FROM contact_submissions WHERE conversation_id = ? AND proposal_version = ?')
      .all(conversationId, version) as unknown as SubmissionRow[];
  }
  insertSubmission(s: SubmissionRow): void {
    this.db
      .prepare(
        `INSERT INTO contact_submissions (conversation_id, proposal_version, participant_id, channel, sealed_value, key_id, consent_at, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id, proposal_version, participant_id) DO UPDATE SET channel = excluded.channel, sealed_value = excluded.sealed_value,
           key_id = excluded.key_id, consent_at = excluded.consent_at, provenance = excluded.provenance`,
      )
      .run(s.conversation_id, s.proposal_version, s.participant_id, s.channel, s.sealed_value, s.key_id, s.consent_at, s.provenance);
  }

  // -- events -------------------------------------------------------------
  emitEvent(recipientId: string, type: string, payload: Record<string, unknown>): number {
    const res = this.db
      .prepare('INSERT INTO events (recipient_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(recipientId, type, JSON.stringify(payload), utcNow());
    return Number(res.lastInsertRowid);
  }
  pollEvents(recipientId: string, afterId: number, limit: number): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE recipient_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(recipientId, afterId, limit) as unknown as EventRow[];
  }

  // -- blocks -------------------------------------------------------------
  isBlockedPair(x: string, y: string): boolean {
    const row = this.db
      .prepare('SELECT 1 AS b FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1')
      .get(x, y, y, x) as { b: number } | undefined;
    return !!row;
  }
  insertBlock(blocker: string, blocked: string): void {
    this.db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(blocker, blocked, utcNow());
  }

  // -- facilitator --------------------------------------------------------
  getRun(conversationId: string, inputRev: number): FacilitatorRunRow | undefined {
    return this.db
      .prepare('SELECT * FROM facilitator_runs WHERE conversation_id = ? AND input_rev = ?')
      .get(conversationId, inputRev) as FacilitatorRunRow | undefined;
  }
  getRunById(id: string): FacilitatorRunRow | undefined {
    return this.db.prepare('SELECT * FROM facilitator_runs WHERE id = ?').get(id) as FacilitatorRunRow | undefined;
  }
  insertRun(r: Omit<FacilitatorRunRow, 'created_at' | 'updated_at'>): void {
    const now = utcNow();
    this.db
      .prepare(
        `INSERT INTO facilitator_runs (id, conversation_id, input_rev, context_hash, status, lease_expires_at, prompt_version, model_id, action, message_id, latency_ms, usage_json, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.conversation_id, r.input_rev, r.context_hash, r.status, r.lease_expires_at, r.prompt_version, r.model_id, r.action, r.message_id, r.latency_ms, r.usage_json, r.error, now, now);
  }
  updateRun(id: string, patch: Partial<Pick<FacilitatorRunRow, 'status' | 'action' | 'message_id' | 'latency_ms' | 'usage_json' | 'error' | 'lease_expires_at'>>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    sets.push('updated_at = ?');
    vals.push(utcNow(), id);
    this.db.prepare(`UPDATE facilitator_runs SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
  }
  insertFacilitatorAssessment(runId: string, conversationId: string, inputRev: number, action: string, reasons: unknown, tensions: unknown, unknowns: unknown): void {
    this.db
      .prepare(
        `INSERT INTO facilitator_assessments (run_id, conversation_id, input_rev, action, reasons_json, tensions_json, unknowns_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, conversationId, inputRev, action, JSON.stringify(reasons), JSON.stringify(tensions), JSON.stringify(unknowns), utcNow());
  }
  latestFacilitatorAssessment(conversationId: string): { action: string; input_rev: number } | undefined {
    return this.db
      .prepare('SELECT action, input_rev FROM facilitator_assessments WHERE conversation_id = ? ORDER BY input_rev DESC LIMIT 1')
      .get(conversationId) as { action: string; input_rev: number } | undefined;
  }

  // -- idempotency --------------------------------------------------------
  getIdempotent(actorId: string, operation: string, requestId: string): { payload_hash: string; result_json: string } | undefined {
    return this.db
      .prepare('SELECT payload_hash, result_json FROM idempotency WHERE actor_id = ? AND operation = ? AND request_id = ?')
      .get(actorId, operation, requestId) as { payload_hash: string; result_json: string } | undefined;
  }
  putIdempotent(actorId: string, operation: string, requestId: string, payloadHash: string, resultJson: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO idempotency (actor_id, operation, request_id, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actorId, operation, requestId, payloadHash, resultJson, utcNow());
  }
}
