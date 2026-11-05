import type { DatabaseSync } from 'node:sqlite';
import type { MupitConfig } from '../config.js';
import { Store } from '../db/store.js';
import { MupitError, notFound } from '../domain/errors.js';
import { detectIdentifiers } from '../domain/identifiers.js';
import { randomId } from '../security/tokens.js';
import { logEvent } from '../security/redaction.js';
import { buildContext } from './context.js';
import { FACILITATOR_PROMPT_VERSION, FACILITATOR_SYSTEM_PROMPT } from './prompt.js';
import { FacilitatorOutputSchema, type FacilitatorOutput } from './schema.js';
import type { FacilitatorProvider } from './provider.js';

export type FacilitateStatus =
  | 'complete'
  | 'waiting_for_agent'
  | 'waiting_for_human'
  | 'in_progress'
  | 'stale_context'
  | 'provider_unavailable';

const LEASE_MS = 180_000;
const INTRO_REF_RE = /^intro:(p_[0-9a-f]{24}):(v\d+|age|about_me|looking_for|relationship_intent|region|open_to_long_distance|interests|values|lifestyle|dealbreakers|preferences)$/;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function leaseExpired(iso: string): boolean {
  return Date.parse(iso) <= Date.now();
}

function validateOutput(output: unknown, store: Store, conversationId: string, pair: [string, string]): FacilitatorOutput {
  let parsed: FacilitatorOutput;
  try {
    parsed = FacilitatorOutputSchema.parse(output);
  } catch (err) {
    const issues = err && typeof err === 'object' && 'issues' in err ? JSON.stringify((err as { issues: unknown }).issues).slice(0, 500) : String(err);
    throw new MupitError('PROVIDER_ERROR', `Facilitator output failed schema validation: ${issues}`, undefined, true);
  }
  for (const pid of [...parsed.addressed_participant_ids, ...parsed.awaiting_participant_ids]) {
    if (pid !== pair[0] && pid !== pair[1]) {
      throw new MupitError('PROVIDER_ERROR', `Facilitator addressed an unknown participant "${pid}".`, undefined, true);
    }
  }
  for (const ref of parsed.evidence_refs) {
    if (ref.startsWith('m_')) {
      const msg = store.getMessage(ref);
      if (!msg || msg.conversation_id !== conversationId) {
        throw new MupitError('PROVIDER_ERROR', `Facilitator cited unknown evidence "${ref}".`, undefined, true);
      }
    } else if (!INTRO_REF_RE.test(ref) || (!ref.includes(pair[0]) && !ref.includes(pair[1]))) {
      throw new MupitError('PROVIDER_ERROR', `Facilitator cited malformed evidence "${ref}". Expected a message ID or "intro:<participant_id>:<field>".`, undefined, true);
    }
  }
  const hits = detectIdentifiers(parsed.message);
  if (hits.length > 0) {
    throw new MupitError('PROVIDER_ERROR', `Facilitator message failed identifier screening (${hits.join(', ')}).`, undefined, false);
  }
  return parsed;
}

/**
 * One bounded facilitator turn. Never holds a DB write lock across the
 * network call: claim lease (txn) -> infer (no lock) -> revalidate+commit (txn).
 */
type Claim =
  | { kind: 'ended'; status: string; revision: number }
  | { kind: 'stale'; current_revision: number }
  | { kind: 'committed'; run: import('../db/store.js').FacilitatorRunRow; revision: number }
  | { kind: 'in_progress'; run: import('../db/store.js').FacilitatorRunRow; revision: number }
  | { kind: 'waiting_for_agent'; revision: number; awaiting_participant_ids: string[] }
  | { kind: 'waiting_for_human'; revision: number; awaiting_participant_ids: string[] }
  | { kind: 'claimed'; run_id: string; input_rev: number; userContent: string; contextHash: string; revision: number };

export async function facilitate(
  db: DatabaseSync,
  cfg: MupitConfig,
  provider: FacilitatorProvider,
  callerId: string,
  conversationId: string,
  expectedRevision: number,
): Promise<Record<string, unknown>> {
  const store = new Store(db);

  // --- Phase 1: validate + claim (short transaction) -----------------------
  const claim: Claim = store.transaction((): Claim => {
    const conv = store.getConversation(conversationId);
    if (!conv) throw notFound('conversation');
    if (conv.a_id !== callerId && conv.b_id !== callerId) throw notFound('conversation');
    if (store.isBlockedPair(conv.a_id, conv.b_id)) throw notFound('conversation');
    if (conv.status !== 'active') {
      return { kind: 'ended' as const, status: conv.status, revision: conv.revision };
    }
    if (conv.revision !== expectedRevision) {
      return { kind: 'stale' as const, current_revision: conv.revision };
    }
    const existing = store.getRun(conv.id, conv.revision);
    if (existing?.status === 'complete') {
      return { kind: 'committed' as const, run: existing, revision: conv.revision };
    }
    if (existing?.status === 'in_progress' && !leaseExpired(existing.lease_expires_at)) {
      return { kind: 'in_progress' as const, run: existing, revision: conv.revision };
    }
    // Eligibility: new eligible input since the last consumed revision?
    const { lastMupitSeq, latestAgentSeq } = store.latestAgentSeqAfterLastMupit(conv.id);
    const lastMupit = lastMupitSeq > 0 ? store.listMessages(conv.id, lastMupitSeq - 1, 1)[0] : undefined;
    const awaiting: string[] = lastMupit ? (JSON.parse(lastMupit.addressed_ids_json) as string[]) : [conv.a_id, conv.b_id];
    const awaitingHuman = awaiting.some((pid) => store.getAssessment(conv.id, pid)?.assessment === 'needs_user_input');
    const waitingKind: 'waiting_for_agent' | 'waiting_for_human' = awaitingHuman ? 'waiting_for_human' : 'waiting_for_agent';
    if (conv.facil_last_input_rev >= conv.revision) {
      return { kind: waitingKind, revision: conv.revision, awaiting_participant_ids: awaiting };
    }
    const agentAdvanced = lastMupitSeq === 0 ? latestAgentSeq > 0 : latestAgentSeq > lastMupitSeq;
    if (!agentAdvanced) {
      // v1: assessment/proposal-only changes do not trigger inference; the
      // agents already received those state events and can discuss them.
      return { kind: waitingKind, revision: conv.revision, awaiting_participant_ids: awaiting };
    }
    const { userContent, contextHash } = buildContext(store, conv.id);
    const runId = existing ? existing.id : randomId('r');
    const lease = new Date(Date.now() + LEASE_MS).toISOString();
    try {
      if (existing) {
        store.updateRun(existing.id, { status: 'in_progress', lease_expires_at: lease, error: null });
      } else {
        store.insertRun({
          id: runId, conversation_id: conv.id, input_rev: conv.revision, context_hash: contextHash,
          status: 'in_progress', lease_expires_at: lease, prompt_version: FACILITATOR_PROMPT_VERSION,
          model_id: provider.modelId, action: null, message_id: null, latency_ms: null, usage_json: null, error: null,
        });
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = store.getRun(conv.id, conv.revision);
        if (raced?.status === 'complete') return { kind: 'committed' as const, run: raced, revision: conv.revision };
        if (raced) return { kind: 'in_progress' as const, run: raced, revision: conv.revision };
      }
      throw err;
    }
    return { kind: 'claimed' as const, run_id: runId, input_rev: conv.revision, userContent, contextHash, revision: conv.revision };
  });

  if (claim.kind === 'ended') {
    return { status: 'complete', note: `Matchmaking for this conversation has ended (${claim.status}).`, revision: claim.revision };
  }
  if (claim.kind === 'stale') {
    return { status: 'stale_context', current_revision: claim.current_revision, retryable: true };
  }
  if (claim.kind === 'committed') {
    return {
      status: 'complete', run_id: claim.run.id, action: claim.run.action, message_id: claim.run.message_id,
      revision: claim.revision, deduplicated: true, provider: { model: claim.run.model_id, label: provider.label },
    };
  }
  if (claim.kind === 'in_progress') {
    return { status: 'in_progress', run_id: claim.run.id, lease_expires_at: claim.run.lease_expires_at, revision: claim.revision };
  }
  if (claim.kind === 'waiting_for_agent' || claim.kind === 'waiting_for_human') {
    return { status: claim.kind, revision: claim.revision, awaiting_participant_ids: claim.awaiting_participant_ids };
  }

  // --- Phase 2: inference (no DB lock held) --------------------------------
  const opts = { timeoutMs: cfg.facilitatorTimeoutMs, maxOutputTokens: cfg.facilitatorMaxOutputTokens };
  let callResult: Awaited<ReturnType<FacilitatorProvider['complete']>>;
  try {
    callResult = await provider.complete(FACILITATOR_SYSTEM_PROMPT, claim.userContent, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof MupitError ? err.retryable : true;
    const code = err instanceof MupitError ? err.code : 'PROVIDER_UNAVAILABLE';
    new Store(db).updateRun(claim.run_id, { status: 'failed', error: `${code}: ${msg.slice(0, 300)}` });
    logEvent('facilitator.provider_failed', { conversation_id: conversationId, run_id: claim.run_id, code, retryable });
    if (code === 'SETUP_ERROR') throw err;
    return { status: 'provider_unavailable', error: msg, retryable, run_id: claim.run_id };
  }
  logEvent('facilitator.inference_done', {
    conversation_id: conversationId, run_id: claim.run_id, model: callResult.modelId,
    latency_ms: callResult.latencyMs, usage: callResult.usage,
  });

  // Validate (+ one bounded repair attempt on schema failure).
  const store2 = new Store(db);
  const convNow = store2.getConversation(conversationId);
  if (!convNow) throw notFound('conversation');
  const pair: [string, string] = [convNow.a_id, convNow.b_id];
  let output: FacilitatorOutput;
  try {
    output = validateOutput(callResult.outputJson, store2, conversationId, pair);
  } catch (firstErr) {
    if (!(firstErr instanceof MupitError) || firstErr.code !== 'PROVIDER_ERROR' || firstErr.retryable !== true) {
      store2.updateRun(claim.run_id, { status: 'failed', error: String(firstErr instanceof Error ? firstErr.message : firstErr).slice(0, 300) });
      throw firstErr;
    }
    try {
      const repair = await provider.complete(
        FACILITATOR_SYSTEM_PROMPT,
        claim.userContent + `\n\nYour previous output failed validation: ${firstErr.message}. Return ONLY corrected JSON matching the schema, citing only evidence that exists.`,
        opts,
      );
      callResult = repair;
      output = validateOutput(repair.outputJson, store2, conversationId, pair);
    } catch (repairErr) {
      const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
      store2.updateRun(claim.run_id, { status: 'failed', error: `invalid-output: ${msg.slice(0, 300)}` });
      logEvent('facilitator.invalid_output', { conversation_id: conversationId, run_id: claim.run_id });
      return { status: 'provider_unavailable', error: `Facilitator output failed validation: ${msg}`, retryable: true, run_id: claim.run_id };
    }
  }

  // --- Phase 3: revalidate + commit (short transaction) --------------------
  return store2.transaction(() => {
    const conv = store2.getConversation(conversationId);
    if (!conv) throw notFound('conversation');
    if (conv.status !== 'active' || conv.revision !== claim.input_rev || store2.isBlockedPair(conv.a_id, conv.b_id)) {
      store2.updateRun(claim.run_id, { status: 'stale', error: 'context changed during inference' });
      return { status: 'stale_context', current_revision: conv.revision, retryable: true, run_id: claim.run_id };
    }
    if (output.action === 'wait') {
      store2.updateRun(claim.run_id, {
        status: 'complete', action: output.action, latency_ms: callResult.latencyMs,
        usage_json: JSON.stringify(callResult.usage ?? null),
      });
      store2.insertFacilitatorAssessment(claim.run_id, conv.id, claim.input_rev, output.action, output.reasons, output.tensions, output.unknowns);
      store2.setFacilConsumedRev(conv.id, claim.input_rev);
      return {
        status: 'complete', run_id: claim.run_id, action: 'wait', message_id: null,
        revision: conv.revision, awaiting_participant_ids: output.awaiting_participant_ids,
        provider: { model: callResult.modelId, label: provider.label, latency_ms: callResult.latencyMs, usage: callResult.usage },
      };
    }
    const kind = output.action === 'ask_agents' || output.action === 'needs_clarification' ? 'question' : 'assessment';
    const seq = store2.nextMessageSeq(conv.id);
    const messageId = randomId('m');
    store2.insertMessage({
      id: messageId, conversation_id: conv.id, seq, sender_role: 'mupit', sender_participant_id: null,
      addressed_ids_json: JSON.stringify(output.addressed_participant_ids),
      kind, body: output.message, evidence_json: JSON.stringify(output.evidence_refs),
    });
    const revision = store2.bumpRevision(conv.id);
    store2.setFacilConsumedRev(conv.id, claim.input_rev);
    store2.updateRun(claim.run_id, {
      status: 'complete', action: output.action, message_id: messageId,
      latency_ms: callResult.latencyMs, usage_json: JSON.stringify(callResult.usage ?? null),
    });
    store2.insertFacilitatorAssessment(claim.run_id, conv.id, claim.input_rev, output.action, output.reasons, output.tensions, output.unknowns);
    for (const pid of pair) {
      store2.emitEvent(pid, 'message.created', {
        conversation_id: conv.id, message_id: messageId, seq, sender_role: 'mupit',
        sender_participant_id: null, addressed_participant_ids: output.addressed_participant_ids,
        kind, body: output.message,
      });
    }
    return {
      status: 'complete', run_id: claim.run_id, action: output.action, message_id: messageId, seq,
      revision, reasons: output.reasons, tensions: output.tensions, unknowns: output.unknowns,
      evidence_refs: output.evidence_refs, awaiting_participant_ids: output.awaiting_participant_ids,
      provider: { model: callResult.modelId, label: provider.label, latency_ms: callResult.latencyMs, usage: callResult.usage },
    };
  });
}
