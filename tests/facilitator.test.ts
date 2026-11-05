import { describe, expect, it } from 'vitest';
import { INTRO_A, INTRO_B, PREFS_A, PREFS_B, TClient, makeTestContext, registerUser, req } from './helpers.js';
import { facilitate } from '../src/facilitator/runner.js';
import type { FacilitatorProvider, ProviderCallOptions, ProviderCallResult } from '../src/facilitator/provider.js';

class DeferredProvider implements FacilitatorProvider {
  readonly label = 'test-deferred';
  readonly modelId = 'test-deferred-v1';
  calls = 0;
  private resolvers: Array<(v: ProviderCallResult) => void> = [];
  async complete(_s: string, _u: string, _o: ProviderCallOptions): Promise<ProviderCallResult> {
    this.calls += 1;
    return new Promise<ProviderCallResult>((resolve) => this.resolvers.push(resolve));
  }
  resolveAll(value: ProviderCallResult): void {
    const rs = this.resolvers;
    this.resolvers = [];
    for (const r of rs) r(value);
  }
}

function validOutput(a: string, b: string, evidence: string): Record<string, unknown> {
  return {
    action: 'ask_agents', addressed_participant_ids: [a, b], message: 'Agents: ask your humans about time-together balance, please.',
    reasons: ['Filters passed.'], tensions: [], unknowns: ['Time balance unstated.'],
    evidence_refs: [evidence], awaiting_participant_ids: [a, b],
  };
}

async function openPair() {
  const ctx = makeTestContext();
  const a = await TClient.connect(ctx, 'a');
  const b = await TClient.connect(ctx, 'b');
  const A = await registerUser(a, 'a', INTRO_A, PREFS_A);
  const B = await registerUser(b, 'b', INTRO_B, PREFS_B);
  const opened = await a.call('mupit_open_conversation', {
    participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'What does a good week look like?',
  });
  return { ctx, a, b, A, B, conv: String(opened.conversation_id) };
}

describe('facilitator (acceptance #21, #22, #23, #25)', () => {
  it('first turn asks; repeat with no new input waits; polls never infer', async () => {
    const { ctx, a, b, A, B, conv } = await openPair();
    try {
      const read = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      const f1 = await a.call('mupit_facilitate', { participant_token: A.token, request_id: req(), conversation_id: conv, expected_revision: (read as { revision: number }).revision });
      expect(f1.status).toBe('complete');
      expect((f1.provider as { label: string }).label).toBe('mock');
      const runs1 = (ctx.db.prepare('SELECT COUNT(*) AS n FROM facilitator_runs').get() as { n: number }).n;
      expect(runs1).toBe(1);
      // Polls + reads create no inference.
      const probe = await registerUser(b, 'probe', INTRO_A, PREFS_A);
      await b.call('mupit_poll', { participant_token: probe.token });
      await b.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      const runs2 = (ctx.db.prepare('SELECT COUNT(*) AS n FROM facilitator_runs').get() as { n: number }).n;
      expect(runs2).toBe(1);
      // Same (now old) revision again: retryable stale, and NO second inference.
      const f1b = await a.call('mupit_facilitate', { participant_token: A.token, request_id: req(), conversation_id: conv, expected_revision: (read as { revision: number }).revision });
      expect(f1b.status).toBe('stale_context');
      const runs3 = (ctx.db.prepare('SELECT COUNT(*) AS n FROM facilitator_runs').get() as { n: number }).n;
      expect(runs3).toBe(1);
      // A committed wait-turn (no message, no revision bump) deduplicates on repeat.
      await b.call('mupit_send_message', { participant_token: B.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'One angle from B.' });
      const readW = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      const revW = (readW as { revision: number }).revision;
      const pairIds = (readW.participants as Array<{ participant_id: string }>).map((p) => p.participant_id);
      const waitProvider: FacilitatorProvider = {
        label: 'test-wait', modelId: 'test-wait-v1',
        complete: async () => ({
          outputJson: {
            action: 'wait', addressed_participant_ids: pairIds, message: 'Still waiting for both agents.',
            reasons: [], tensions: [], unknowns: ['Both replies pending.'], evidence_refs: [], awaiting_participant_ids: pairIds,
          },
          modelId: 'test-wait-v1', latencyMs: 1, usage: null,
        }),
      };
      const w1 = await facilitate(ctx.db, ctx.cfg, waitProvider, A.id, conv, revW);
      expect(w1.status).toBe('complete');
      expect(w1.action).toBe('wait');
      const w2 = await facilitate(ctx.db, ctx.cfg, waitProvider, A.id, conv, revW);
      expect(w2.status).toBe('complete');
      expect(w2.deduplicated).toBe(true);
      const mupitCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_role = 'mupit'").get(conv) as { n: number }).n;
      expect(mupitCount).toBe(1); // wait turns persist no message
    } finally {
      await a.close(); await b.close();
      ctx.close();
    }
  });

  it('waiting states distinguish agent vs human; stale revisions are retryable', async () => {
    const { ctx, a, b, A, B, conv } = await openPair();
    try {
      const read = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      await a.call('mupit_facilitate', { participant_token: A.token, request_id: req(), conversation_id: conv, expected_revision: (read as { revision: number }).revision });
      const read2 = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      const rev2 = (read2 as { revision: number }).revision;
      const w1 = await a.call('mupit_facilitate', { participant_token: A.token, request_id: req(), conversation_id: conv, expected_revision: rev2 });
      expect(w1.status).toBe('waiting_for_agent');
      // B flags needs_user_input -> waiting_for_human.
      await b.call('mupit_set_assessment', {
        participant_token: B.token, request_id: req(), conversation_id: conv, assessment: 'needs_user_input', rationale: 'must ask my human',
      });
      const read3 = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      const w2 = await a.call('mupit_facilitate', { participant_token: A.token, request_id: req(), conversation_id: conv, expected_revision: (read3 as { revision: number }).revision });
      expect(w2.status).toBe('waiting_for_human');
      // Stale revision.
      const stale = await a.call('mupit_facilitate', { participant_token: A.token, request_id: req(), conversation_id: conv, expected_revision: 1 });
      expect(stale.status).toBe('stale_context');
      expect(stale.retryable).toBe(true);
    } finally {
      await a.close(); await b.close();
      ctx.close();
    }
  });

  it('context change during inference discards stale output without attaching it', async () => {
    const { ctx, a, b, A, B, conv } = await openPair();
    try {
      const read = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      const rev = (read as { revision: number }).revision;
      const provider = new DeferredProvider();
      const pending = facilitate(ctx.db, ctx.cfg, provider, A.id, conv, rev);
      await new Promise((r) => setTimeout(r, 50)); // let phase 1 claim the lease
      expect(provider.calls).toBe(1);
      // Concurrent agent input changes the context mid-inference.
      await b.call('mupit_send_message', { participant_token: B.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'Meanwhile, from B.' });
      const firstMsg = (ctx.db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT 1').get(conv) as { id: string }).id;
      provider.resolveAll({ outputJson: validOutput(A.id, B.id, firstMsg), modelId: provider.modelId, latencyMs: 5, usage: null });
      const result = await pending;
      expect(result.status).toBe('stale_context');
      const mupitCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_role = 'mupit'").get(conv) as { n: number }).n;
      expect(mupitCount).toBe(0);
      const run = ctx.db.prepare('SELECT status FROM facilitator_runs WHERE conversation_id = ? AND input_rev = ?').get(conv, rev) as { status: string };
      expect(run.status).toBe('stale');
    } finally {
      await a.close(); await b.close();
      ctx.close();
    }
  });

  it('invalid output fails safely; failed runs are reclaimable; timeouts preserve state', async () => {
    const { ctx, a, b, A, B, conv } = await openPair();
    try {
      const read = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      const rev = (read as { revision: number }).revision;
      let flakyCalls = 0;
      const badThenGood: FacilitatorProvider = {
        label: 'test-flaky', modelId: 'test-flaky-v1',
        complete: async (): Promise<ProviderCallResult> => {
          flakyCalls += 1;
          if (flakyCalls === 1) return { outputJson: { action: 'bogus_action' }, modelId: 'test-flaky-v1', latencyMs: 1, usage: null };
          const firstMsg = (ctx.db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT 1').get(conv) as { id: string }).id;
          return { outputJson: validOutput(A.id, B.id, firstMsg), modelId: 'test-flaky-v1', latencyMs: 1, usage: null };
        },
      };
      // One bounded repair attempt inside the same run -> complete.
      const r1 = await facilitate(ctx.db, ctx.cfg, badThenGood, A.id, conv, rev);
      expect(r1.status).toBe('complete');

      // Timeout provider: run fails, messages + consent state untouched.
      await b.call('mupit_send_message', { participant_token: B.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'Another answer.' });
      const read2 = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
      const rev2 = (read2 as { revision: number }).revision;
      const timeoutProvider: FacilitatorProvider = {
        label: 'test-timeout', modelId: 'test-timeout-v1',
        complete: async () => {
          const err = new Error('timed out');
          err.name = 'TimeoutError';
          throw err;
        },
      };
      const r2 = await facilitate(ctx.db, ctx.cfg, timeoutProvider, A.id, conv, rev2);
      expect(r2.status).toBe('provider_unavailable');
      expect(r2.retryable).toBe(true);
      const proposals = (ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_proposals').get() as { n: number }).n;
      expect(proposals).toBe(0);
      const agentMsgs = (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_role = 'personal_agent'").get(conv) as { n: number }).n;
      expect(agentMsgs).toBe(2); // opener + 'Another answer'; failed inference added nothing
    } finally {
      await a.close(); await b.close();
      ctx.close();
    }
  });

  it('provider context is allowlisted; output cannot approve/release or address outsiders', async () => {
    const { ctx, a, b, A, B, conv } = await openPair();
    try {
      const c = await TClient.connect(ctx, 'c');
      const C = await registerUser(c, 'c', INTRO_A, PREFS_A);
      try {
        // A submits a contact (vault value must never reach the model).
        await a.call('mupit_propose_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, expected_version: 0, channel: 'email', human_confirmed: true,
        });
        await b.call('mupit_respond_connection', {
          participant_token: B.token, request_id: req(), conversation_id: conv, proposal_version: 1, decision: 'accept', human_confirmed: true,
        });
        await a.call('mupit_submit_contact', {
          participant_token: A.token, request_id: req(), conversation_id: conv, proposal_version: 1,
          channel: 'email', contact_value: 'vault.secret@example.com', human_confirmed: true,
        });

        let captured = '';
        const recording: FacilitatorProvider = {
          label: 'test-recording', modelId: 'test-recording-v1',
          complete: async (_s: string, u: string) => {
            captured = u;
            const firstMsg = (ctx.db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY seq ASC LIMIT 1').get(conv) as { id: string }).id;
            return { outputJson: validOutput(A.id, B.id, firstMsg), modelId: 'test-recording-v1', latencyMs: 1, usage: null };
          },
        };
        const read = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
        // New agent message to make input eligible (last turn state: none yet).
        await b.call('mupit_send_message', { participant_token: B.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'Eligibility note.' });
        const read2 = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
        void read;
        const r = await facilitate(ctx.db, ctx.cfg, recording, A.id, conv, (read2 as { revision: number }).revision);
        expect(r.status).toBe('complete');
        expect(captured).toContain(conv);
        expect(captured).toContain(A.id);
        for (const needle of [A.token, B.token, C.token, 'vault.secret@example.com', C.id, 'META_API_KEY', 'sealed']) {
          expect(captured.includes(needle)).toBe(false);
        }
        // Facilitator created no approvals/releases.
        const subs = (ctx.db.prepare('SELECT COUNT(*) AS n FROM contact_submissions').get() as { n: number }).n;
        expect(subs).toBe(1); // only A's own submission
        const proposal = ctx.db.prepare('SELECT status FROM connection_proposals WHERE conversation_id = ?').get(conv) as { status: string };
        expect(proposal.status).toBe('awaiting_contacts');

        // Output addressing an outsider is rejected; nothing persisted.
        await a.call('mupit_send_message', { participant_token: A.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'Yet another.' });
        const read3 = await a.call('mupit_read_conversation', { participant_token: A.token, conversation_id: conv });
        const evil: FacilitatorProvider = {
          label: 'test-evil', modelId: 'test-evil-v1',
          complete: async () => ({ outputJson: validOutput(A.id, C.id, 'm_bogus'), modelId: 'test-evil-v1', latencyMs: 1, usage: null }),
        };
        const rEvil = await facilitate(ctx.db, ctx.cfg, evil, A.id, conv, (read3 as { revision: number }).revision);
        expect(rEvil.status).toBe('provider_unavailable');
        const mupitCount = (ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_role = 'mupit'").get(conv) as { n: number }).n;
        expect(mupitCount).toBe(1); // only the earlier valid turn
      } finally {
        await c.close();
      }
    } finally {
      await a.close(); await b.close();
      ctx.close();
    }
  });
});
