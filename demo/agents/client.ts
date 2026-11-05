import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentState, PersonaFixture } from './types.js';
import { randomRequestId } from '../../src/security/tokens.js';

/** Directory holding private per-agent state (tokens, cursors). Gitignored. */
export function stateDir(): string {
  return process.env.MUPIT_DEMO_STATE_DIR ?? 'demo/state';
}

export function loadFixture(name: string): PersonaFixture {
  const path = join('demo', 'fixtures', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as PersonaFixture;
}

export function loadState(name: string): AgentState | null {
  const path = join(stateDir(), `${name}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as AgentState;
}

export function saveState(state: AgentState): void {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${state.name}.json`);
  // Plain write + 0600 (state dir itself is gitignored and local-only).
  writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** MCP tool envelope helpers (server returns {ok, ...} in text + structured). */
export function unwrap(tool: string, res: unknown): Record<string, unknown> {
  const r = res as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
  if (r.structuredContent && typeof r.structuredContent === 'object') {
    const body = r.structuredContent as Record<string, unknown>;
    if (r.isError || body.ok === false) {
      throw new SimToolError(tool, String(body.code ?? 'UNKNOWN'), String(body.message ?? 'tool failed'), body);
    }
    return body;
  }
  const text = r.content?.[0]?.text ?? '';
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (r.isError || body.ok === false) {
      throw new SimToolError(tool, String(body.code ?? 'UNKNOWN'), String(body.message ?? 'tool failed'), body);
    }
    return body;
  } catch (err) {
    if (err instanceof SimToolError) throw err;
    throw new Error(`[${tool}] unparseable response: ${text.slice(0, 200)}`);
  }
}

export class SimToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(`[${tool}] ${code}: ${message}`);
  }
}

/** One isolated MCP client session per simulated agent (own token + cursor). */
export class SimClient {
  private constructor(
    readonly name: string,
    readonly client: Client,
    readonly state: AgentState,
  ) {}

  static async connect(name: string, url: string): Promise<SimClient> {
    const client = new Client({ name: `mupit-sim-${name}`, version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return SimClient.connectWith(name, client);
  }

  /** Wrap an already-connected MCP client (used by tests with in-memory transports). */
  static connectWith(name: string, client: Client): SimClient {
    const state = loadState(name);
    if (!state || !state.token) throw new Error(`No saved credentials for simulated agent "${name}". Run seed:demo first.`);
    return new SimClient(name, client, state);
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }

  nextRequestId(): string {
    this.state.request_seq += 1;
    return `${randomRequestId()}-n${this.state.request_seq}`;
  }

  persist(): void {
    saveState(this.state);
  }

  /** Authenticated tool call. Token is injected by the wrapper, never by the model. */
  async call(tool: string, args: Record<string, unknown>, mutating = false): Promise<Record<string, unknown>> {
    const full: Record<string, unknown> = { participant_token: this.state.token, ...args };
    if (mutating) full.request_id = this.nextRequestId();
    const res = await this.client.callTool({ name: tool, arguments: full });
    return unwrap(tool, res);
  }
}
