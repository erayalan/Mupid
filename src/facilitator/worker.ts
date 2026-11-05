import type { DatabaseSync } from 'node:sqlite';
import type { MupitConfig } from '../config.js';
import { Store } from '../db/store.js';
import { MupitError } from '../domain/errors.js';
import { recheckPair } from '../domain/conversations.js';
import { logEvent } from '../security/redaction.js';
import { createProvider, type FacilitatorProvider } from './provider.js';
import { facilitate } from './runner.js';

interface Job {
  conversation_id: string;
  input_seq: number;
  attempts: number;
}

/** Durable server-owned coordination. No participant tokens or human consent. */
export class MediationWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private active: Promise<void> | undefined;
  private readonly store: Store;

  constructor(
    private readonly db: DatabaseSync,
    private readonly cfg: MupitConfig,
    private readonly provider: () => FacilitatorProvider = () => createProvider(cfg),
  ) {
    this.store = new Store(db);
  }

  start(): void {
    // Recover eligible threads that predate the queue, without resetting failed
    // or leased jobs. Existing queued work already survives process restarts.
    this.db.prepare(`INSERT OR IGNORE INTO mediation_jobs (conversation_id, input_seq, next_attempt_at)
      SELECT c.id, MAX(m.seq), ? FROM conversations c JOIN messages m ON m.conversation_id=c.id
      WHERE c.status='active' AND c.revision>c.facil_last_input_rev AND m.sender_role='personal_agent'
      AND m.seq>COALESCE((SELECT MAX(f.seq) FROM messages f WHERE f.conversation_id=c.id AND f.sender_role='mupit'),0)
      GROUP BY c.id`).run(Date.now());
    this.timer = setInterval(() => { void this.tick(); }, 500);
    this.timer.unref();
    void this.tick();
  }

  /** Bounded pass; overlapping timer ticks share the same work. */
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.runBatch().catch(() => {
      // Do not log database/provider payloads. Leased jobs remain recoverable.
      logEvent('mediation.worker_failed', {});
    }).finally(() => { this.active = undefined; });
    return this.active;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }

  private claim(): Job | undefined {
    return this.store.transaction(() => {
      const now = Date.now();
      const row = this.db.prepare(`SELECT conversation_id, input_seq, attempts FROM mediation_jobs
        WHERE (status='pending' AND next_attempt_at<=?) OR (status='running' AND lease_expires_at<=?)
        ORDER BY next_attempt_at, conversation_id LIMIT 1`).get(now, now) as Job | undefined;
      if (!row) return undefined;
      this.db.prepare(`UPDATE mediation_jobs SET status='running', attempts=attempts+1, lease_expires_at=?
        WHERE conversation_id=?`).run(now + 180_000, row.conversation_id);
      return { ...row, attempts: row.attempts + 1 };
    });
  }

  private async runBatch(): Promise<void> {
    // Small concurrency keeps one slow inference from blocking every pair.
    const jobs = [this.claim(), this.claim()].filter((job): job is Job => !!job);
    await Promise.all(jobs.map(job => this.process(job)));
  }

  private finish(job: Job, status: string, error: string | null = null, delayMs = 0): void {
    // A newer message supersedes an in-flight job. Never consume its pending
    // work, even if this inference finished with stale context or failed.
    this.db.prepare(`UPDATE mediation_jobs SET status=?, next_attempt_at=?, lease_expires_at=0, last_error=?
      WHERE conversation_id=? AND input_seq=? AND status='running'`)
      .run(status, Date.now() + delayMs, error, job.conversation_id, job.input_seq);
  }

  private async process(job: Job): Promise<void> {
    try {
      const conv = this.store.getConversation(job.conversation_id);
      if (!conv || conv.status !== 'active') { this.finish(job, 'complete'); return; }
      recheckPair(this.store, conv.a_id, conv.b_id);
      const { lastMupitSeq, latestAgentSeq } = this.store.latestAgentSeqAfterLastMupit(conv.id);
      if (latestAgentSeq <= lastMupitSeq || conv.revision <= conv.facil_last_input_rev) {
        this.finish(job, 'waiting'); return;
      }
      // Holding messages are not answers. Await fresh approved input from that
      // same agent, rather than repeatedly asking the model to guess it.
      for (const id of [conv.a_id, conv.b_id]) {
        const latest = this.db.prepare(`SELECT kind,seq FROM messages WHERE conversation_id=?
          AND sender_role='personal_agent' AND sender_participant_id=? ORDER BY seq DESC LIMIT 1`)
          .get(conv.id, id) as { kind: string; seq: number } | undefined;
        if (latest && latest.seq > lastMupitSeq && latest.kind === 'needs_user_input') {
          this.finish(job, 'waiting'); return;
        }
      }
      const result = await facilitate(this.db, this.cfg, this.provider(), conv.a_id, conv.id, conv.revision);
      const status = String(result.status);
      if (status === 'provider_unavailable') {
        this.retry(job, result.retryable === true, 'provider_unavailable');
      } else if (status === 'stale_context' || status === 'in_progress') {
        // A context-only change or an explicit legacy caller may win the race.
        this.finish(job, 'pending', null, status === 'in_progress' ? 1000 : 300);
      } else {
        this.finish(job, status === 'complete' ? 'complete' : 'waiting');
      }
      logEvent('mediation.processed', { conversation_id: conv.id, status, action: result.action });
    } catch (err) {
      const retryable = err instanceof MupitError ? err.retryable : true;
      this.retry(job, retryable, err instanceof MupitError ? err.code : 'worker_error');
    }
  }

  private retry(job: Job, retryable: boolean, code: string): void {
    const again = retryable && job.attempts < 3;
    this.finish(job, again ? 'pending' : 'failed', code, again ? 5000 * 2 ** (job.attempts - 1) : 0);
    logEvent('mediation.deferred', { conversation_id: job.conversation_id, code, retrying: again });
  }
}
