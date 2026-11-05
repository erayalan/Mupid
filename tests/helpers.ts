import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { MupitConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { Store } from '../src/db/store.js';
import { ContactVault } from '../src/security/contact-vault.js';
import { WriteRateLimiter, type AppContext } from '../src/mcp/context.js';
import { createMcpServer } from '../src/mcp/tools.js';

export interface TestUser {
  id: string;
  token: string;
  regKey: string;
}

let counter = 0;

export function testConfig(dbPath: string, overrides: Partial<MupitConfig> = {}): MupitConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    dbPath,
    serverSecret: randomBytes(32),
    vaultKey: randomBytes(32),
    vaultKeyId: 'v1',
    metaApiKey: null,
    metaModel: 'muse-spark-1.3',
    metaBaseUrl: 'https://api.meta.ai/v1',
    facilitatorMode: 'mock',
    demoMode: true,
    automaticMediation: false,
    maxMessageChars: 4000,
    maxIntroChars: 1500,
    defaultPageLimit: 20,
    maxPageLimit: 50,
    writeRateLimitPerMin: 10000,
    facilitatorTimeoutMs: 5000,
    facilitatorMaxOutputTokens: 500,
    ...overrides,
  };
}

export function tempDbPath(prefix = 'mupit-test'): string {
  counter += 1;
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-${process.pid}-${counter}-`));
  return join(dir, 'test.db');
}

export function cleanupDbPath(dbPath: string): void {
  try {
    rmSync(join(dbPath, '..'), { recursive: true, force: true });
  } catch { /* best effort */ }
}

export interface TestContext {
  cfg: MupitConfig;
  db: DatabaseSync;
  store: Store;
  vault: ContactVault;
  app: AppContext;
  mcp: McpServer;
  close: () => void;
}

export function makeTestContext(overrides: Partial<MupitConfig> = {}, dbPath?: string): TestContext {
  const path = dbPath ?? tempDbPath();
  const cfg = testConfig(path, overrides);
  const db = openDatabase(path);
  const store = new Store(db);
  const vault = new ContactVault(cfg.vaultKey, cfg.vaultKeyId);
  const app: AppContext = { cfg, db, store, vault, writes: new WriteRateLimiter(cfg.writeRateLimitPerMin) };
  const mcp = createMcpServer(app);
  return {
    cfg, db, store, vault, app, mcp,
    close: () => {
      db.close();
      if (!dbPath) cleanupDbPath(path);
    },
  };
}

/** MCP client speaking to an in-process server over a linked in-memory transport. Each client gets its own McpServer over the SHARED AppContext (database), mirroring independent HTTP clients against one backend. */
export class TClient {
  private constructor(readonly client: Client) {}
  static async connect(ctx: TestContext, name: string): Promise<TClient> {
    const mcp = createMcpServer(ctx.app);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name, version: '0.0.0-test' });
    await Promise.all([mcp.connect(a), client.connect(b)]);
    return new TClient(client);
  }
  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }
  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = (await this.client.callTool({ name: tool, arguments: args })) as {
      isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }>;
    };
    if (!res.structuredContent) {
      const text = res.content?.[0]?.text ?? '';
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        if (res.isError || body.ok === false) {
          const err = new Error(`[${tool}] ${String(body.code)}: ${String(body.message)}`) as Error & { code: string; body: Record<string, unknown> };
          err.code = String(body.code);
          err.body = body;
          throw err;
        }
        return body;
      } catch (err) {
        if (err instanceof Error && 'code' in err) throw err;
        throw new Error(`[${tool}] protocol error (no structured result): ${text.slice(0, 300)}`);
      }
    }
    const body = res.structuredContent as Record<string, unknown>;
    if (res.isError || body.ok === false) {
      const err = new Error(`[${tool}] ${String(body.code)}: ${String(body.message)}`) as Error & { code: string; body: Record<string, unknown> };
      err.code = String(body.code);
      err.body = body;
      throw err;
    }
    return body;
  }
  async fails(tool: string, args: Record<string, unknown>, expectedCode?: string): Promise<Record<string, unknown>> {
    try {
      const ok = await this.call(tool, args);
      throw new Error(`[${tool}] expected failure${expectedCode ? ` (${expectedCode})` : ''} but succeeded: ${JSON.stringify(ok).slice(0, 200)}`);
    } catch (err) {
      const e = err as Error & { code?: string; body?: Record<string, unknown> };
      if (expectedCode && e.code !== expectedCode) {
        throw new Error(`[${tool}] expected ${expectedCode}, got ${e.code}: ${e.message}`);
      }
      if (!e.code) throw err;
      return e.body ?? {};
    }
  }
}

let reqCounter = 0;
export function req(): string {
  reqCounter += 1;
  return `req-test-${Date.now()}-${reqCounter}-${randomBytes(4).toString('hex')}`;
}

export function regKey(tag: string): string {
  return `test-regkey-${tag}-${randomBytes(16).toString('hex')}`;
}

export const INTRO_A = {
  age: 30, about_me: 'Test hiker from Portland who cooks and takes photos.', looking_for: 'A long-term partner with their own passions.',
  relationship_intent: 'long_term', region: 'Portland', open_to_long_distance: true,
  interests: ['hiking'], values: ['independence'], lifestyle: ['non-smoker'], dealbreakers: ['smoking'],
};
export const PREFS_A = { age_min: 26, age_max: 38, gender: 'woman', accepted_genders: ['man'], accepted_intents: ['dating', 'long_term'], same_region_only: false };
export const INTRO_B = {
  age: 32, about_me: 'Test bookworm and gamer from Seattle with a calm routine.', looking_for: 'A long-term partner with a rich inner life.',
  relationship_intent: 'long_term', region: 'Seattle', open_to_long_distance: true,
  interests: ['novels'], values: ['independence'], lifestyle: ['non-smoker'], dealbreakers: ['smoking'],
};
export const PREFS_B = { age_min: 27, age_max: 40, gender: 'man', accepted_genders: ['woman'], accepted_intents: ['dating', 'long_term'], same_region_only: false };
export const INTRO_CASUAL = {
  age: 34, about_me: 'Test casual dater from Austin, honest about it.', looking_for: 'Something casual and local.',
  relationship_intent: 'casual', region: 'Austin', open_to_long_distance: false,
  interests: [], values: [], lifestyle: [], dealbreakers: [],
};
export const PREFS_CASUAL = { age_min: 25, age_max: 38, gender: 'man', accepted_genders: ['woman'], accepted_intents: ['casual'], same_region_only: true };

export async function registerUser(client: TClient, tag: string, intro: unknown = INTRO_A, prefs: unknown = PREFS_A, simulated = false): Promise<TestUser> {
  const key = regKey(tag);
  const res = await client.call('mupit_register', {
    registration_key: key, introduction: intro, preferences: prefs,
    adult_attested: true, publication_confirmed: true, simulated,
  });
  return { id: String(res.participant_id), token: String(res.participant_token), regKey: key };
}
