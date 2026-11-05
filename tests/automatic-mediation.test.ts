import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { MediationWorker } from '../src/facilitator/worker.js';
import { MockProvider, type FacilitatorProvider, type ProviderCallResult } from '../src/facilitator/provider.js';
import { facilitate } from '../src/facilitator/runner.js';
import { MupitError } from '../src/domain/errors.js';
import { INTRO_B, PREFS_B, TClient, makeTestContext, registerUser, req } from './helpers.js';

async function pair() {
  const ctx = makeTestContext({ automaticMediation: true });
  const a = await TClient.connect(ctx, 'auto-a');
  const b = await TClient.connect(ctx, 'auto-b');
  const A = await registerUser(a, 'auto-a');
  const B = await registerUser(b, 'auto-b', INTRO_B, PREFS_B);
  const args = { participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'What weekly rhythm works for your person?' };
  const opened = await a.call('mupit_open_conversation', args);
  const conv = String(opened.conversation_id);
  const due = () => ctx.db.prepare("UPDATE mediation_jobs SET next_attempt_at=0 WHERE status='pending'").run();
  const send = (who: 'a' | 'b', kind = 'answer') => (who === 'a' ? a : b).call('mupit_send_message', {
    participant_token: who === 'a' ? A.token : B.token, request_id: req(), conversation_id: conv,
    kind, body: kind === 'needs_user_input' ? 'I need to ask my human before answering.' : 'Independent weeknights and shared weekends work for my person.',
  });
  const cleanup = async () => { await a.close(); await b.close(); ctx.close(); };
  return { ctx, a, b, A, B, conv, args, due, send, cleanup };
}

function recordingProvider() {
  const mock = new MockProvider();
  let calls = 0;
  const provider: FacilitatorProvider = {
    modelId: mock.modelId, label: mock.label,
    complete: async (system, user, options) => { calls++; return mock.complete(system, user, options); },
  };
  return { provider, calls: () => calls };
}

describe('automatic server mediation', () => {
  it('recovers durable work, deduplicates client retries, and mediates answers without a facilitate call', async () => {
    const p = await pair();
    // A separate database connection represents a replacement server process.
    const db = openDatabase(p.ctx.cfg.dbPath);
    const rec = recordingProvider();
    const worker = new MediationWorker(db, p.ctx.cfg, () => rec.provider);
    try {
      await p.a.call('mupit_open_conversation', p.args); // identical idempotent replay
      expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
      expect((db.prepare('SELECT COUNT(*) AS n FROM mediation_jobs').get() as { n: number }).n).toBe(1);
      p.due();
      await worker.tick();
      const first = await p.a.call('mupit_read_conversation', { participant_token: p.A.token, conversation_id: p.conv });
      expect((first.messages as Array<{ sender_role: string }>).filter(m => m.sender_role === 'mupit')).toHaveLength(1);
      await worker.tick();
      await p.a.call('mupit_poll', { participant_token: p.A.token });
      expect(rec.calls()).toBe(1); // no self-triggering mediator loop
      await p.send('a');
      await p.send('b');
      p.due();
      await worker.tick();
      expect(rec.calls()).toBe(2); // rapid answers coalesce into one current turn
      expect((db.prepare('SELECT COUNT(*) AS n FROM connection_proposals').get() as { n: number }).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM contact_submissions').get() as { n: number }).n).toBe(0);
    } finally { await worker.stop(); db.close(); await p.cleanup(); }
  });

  it('upgrades an existing version-one database and recovers its unmediated thread', async () => {
    const p = await pair();
    p.ctx.db.exec('DROP TABLE mediation_jobs; DELETE FROM migrations WHERE version=2;');
    const upgraded = openDatabase(p.ctx.cfg.dbPath);
    const rec = recordingProvider();
    const worker = new MediationWorker(upgraded, p.ctx.cfg, () => rec.provider);
    try {
      expect((upgraded.prepare('SELECT COUNT(*) AS n FROM participants').get() as { n: number }).n).toBe(2);
      worker.start();
      await worker.tick();
      expect(rec.calls()).toBe(1);
      expect((upgraded.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_role='mupit'").get() as { n: number }).n).toBe(1);
    } finally { await worker.stop(); upgraded.close(); await p.cleanup(); }
  });

  it('preserves newer input during inference and shares the existing lease with manual callers', async () => {
    const p = await pair();
    const mock = new MockProvider();
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let calls = 0;
    const provider: FacilitatorProvider = {
      modelId: mock.modelId, label: mock.label,
      complete: async (s, u, o) => {
        calls++;
        if (calls === 1) { const wait = new Promise<void>(resolve => { release = resolve; }); began(); await wait; }
        return mock.complete(s, u, o);
      },
    };
    const worker = new MediationWorker(p.ctx.db, p.ctx.cfg, () => provider);
    try {
      p.due();
      const pending = worker.tick();
      await started;
      const conv = p.ctx.store.getConversation(p.conv)!;
      const manual = await facilitate(p.ctx.db, p.ctx.cfg, provider, p.A.id, p.conv, conv.revision);
      expect(manual.status).toBe('in_progress');
      expect(calls).toBe(1);
      await p.send('b');
      release();
      await pending;
      expect((p.ctx.db.prepare('SELECT status FROM mediation_jobs').get() as { status: string }).status).toBe('pending');
      expect((p.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_role='mupit'").get() as { n: number }).n).toBe(0);
      p.due();
      await worker.tick();
      expect(calls).toBe(2);
      expect((p.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_role='mupit'").get() as { n: number }).n).toBe(1);
    } finally { release?.(); await worker.stop(); await p.cleanup(); }
  });

  it('waits for the same agent to provide missing human input, and ignores closed pairs', async () => {
    const p = await pair();
    const rec = recordingProvider();
    const worker = new MediationWorker(p.ctx.db, p.ctx.cfg, () => rec.provider);
    try {
      await p.send('a', 'needs_user_input');
      p.due(); await worker.tick();
      expect(rec.calls()).toBe(0);
      await p.send('b');
      p.due(); await worker.tick();
      expect(rec.calls()).toBe(0); // other agent cannot answer for their human
      await p.send('a');
      p.due(); await worker.tick();
      expect(rec.calls()).toBe(1);
      await p.send('b');
      await p.a.call('mupit_close_conversation', { participant_token: p.A.token, request_id: req(), conversation_id: p.conv });
      p.due(); await worker.tick();
      expect(rec.calls()).toBe(1);
    } finally { await worker.stop(); await p.cleanup(); }
  });

  it('bounds transient retries and stops on permanent provider failures without losing the message', async () => {
    const p = await pair();
    let calls = 0;
    let retryable = true;
    const provider: FacilitatorProvider = {
      modelId: 'failing-provider', label: 'test',
      complete: async (): Promise<ProviderCallResult> => {
        calls++;
        throw new MupitError('PROVIDER_UNAVAILABLE', 'Test provider failure.', undefined, retryable);
      },
    };
    const worker = new MediationWorker(p.ctx.db, p.ctx.cfg, () => provider);
    try {
      for (let i = 0; i < 5; i++) { p.due(); await worker.tick(); }
      expect(calls).toBe(3);
      expect((p.ctx.db.prepare('SELECT status FROM mediation_jobs').get() as { status: string }).status).toBe('failed');
      expect((p.ctx.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
      retryable = false;
      await p.send('a');
      p.due(); await worker.tick();
      p.due(); await worker.tick();
      expect(calls).toBe(4);
    } finally { await worker.stop(); await p.cleanup(); }
  });
});
