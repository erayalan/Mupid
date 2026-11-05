import type { DatabaseSync } from 'node:sqlite';
import type { MupitConfig } from '../config.js';
import { Store } from '../db/store.js';
import type { ContactVault } from '../security/contact-vault.js';
import { MupitError } from '../domain/errors.js';

/** Shared server-side application context (one per process). */
export interface AppContext {
  cfg: MupitConfig;
  db: DatabaseSync;
  store: Store;
  vault: ContactVault;
  writes: WriteRateLimiter;
}

/** Sliding-window per-caller write rate limiter (in-memory, local demo scale). */
export class WriteRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perMinute: number) {}

  check(key: string): void {
    const now = Date.now();
    const window = now - 60_000;
    const list = (this.hits.get(key) ?? []).filter((t) => t > window);
    if (list.length >= this.perMinute) {
      throw new MupitError('RATE_LIMITED', `Write rate limit exceeded (${this.perMinute}/minute). Slow down and retry.`, undefined, true);
    }
    list.push(now);
    this.hits.set(key, list);
  }
}
