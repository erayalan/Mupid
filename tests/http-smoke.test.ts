import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';
import { INTRO_A, INTRO_B, PREFS_A, PREFS_B, testConfig } from './helpers.js';

/** Node fetch ignores Host overrides, so use real HTTP requests for virtual hosts. */
async function virtualHostRequest(url: string, host: string, origin?: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Host: host, ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/**
 * Real-socket HTTP smoke test: boots the actual server on an ephemeral port
 * and runs healthz + MCP initialize/tools-list/tools-call through the SDK's
 * Streamable HTTP transports. This is the exact path demo:up/seed use.
 *
 * Skips honestly when the environment forbids listening sockets (restricted
 * sandboxes); it runs in CI and on developer machines.
 */
describe('HTTP transport smoke (real sockets)', () => {
  it('accepts only the configured tunnel host and origin, including registration validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupit-tunnel-host-'));
    const cfg = testConfig(join(dir, 'http.db'), { port: 0, tunnelHost: 'demo.example.com' });
    let server: Awaited<ReturnType<typeof startServer>>;
    try {
      server = await startServer(cfg);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      if (err instanceof Error && /EPERM|EACCES|operation not permitted/i.test(err.message)) {
        console.warn('SKIP tunnel-host socket test: listening sockets are blocked.');
        return;
      }
      throw err;
    }
    try {
      const healthUrl = server.url.replace(/\/mcp$/, '/healthz');
      expect((await virtualHostRequest(healthUrl, 'demo.example.com')).status).toBe(200);
      expect((await virtualHostRequest(healthUrl, 'untrusted.example.com')).status).toBe(403);
      expect((await virtualHostRequest(healthUrl, 'demo.example.com.attacker.com')).status).toBe(403);
      const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'origin-probe', version: '1' } } };
      expect((await virtualHostRequest(server.url, 'demo.example.com', 'https://attacker.example.com', initialize)).status).toBe(403);
      expect((await virtualHostRequest(server.url, 'demo.example.com', 'https://demo.example.com', initialize)).status).toBe(200);
      const result = await virtualHostRequest(server.url, 'demo.example.com', 'https://demo.example.com', {
        jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mupit_register', arguments: {
          registration_key: 'unapproved-route-validation-key',
          introduction: { age: 38, about_me: 'Route validation probe.', looking_for: 'A long-term relationship.', relationship_intent: 'long_term', region: 'Portland', open_to_long_distance: true },
          preferences: { age_min: 30, age_max: 42, accepted_intents: ['long_term'], same_region_only: false },
          adult_attested: false, publication_confirmed: false,
        } },
      });
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body).result.structuredContent).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(cfg.dbPath, { readOnly: true });
      try { expect((db.prepare('SELECT COUNT(*) AS n FROM participants').get() as { n: number }).n).toBe(0); }
      finally { db.close(); }
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('publishes a server-owned mediator turn after an HTTP message without a facilitate request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupit-auto-http-'));
    const cfg = testConfig(join(dir, 'http.db'), { port: 0, automaticMediation: true });
    let server: Awaited<ReturnType<typeof startServer>>;
    try { server = await startServer(cfg); }
    catch (err) {
      rmSync(dir, { recursive: true, force: true });
      if (err instanceof Error && /EPERM|EACCES|operation not permitted/i.test(err.message)) {
        console.warn('SKIP automatic mediation socket test: listening sockets are blocked.');
        return;
      }
      throw err;
    }
    const clients = [new Client({ name: 'auto-http-a', version: '1' }), new Client({ name: 'auto-http-b', version: '1' })];
    try {
      const identities: Array<{ participant_id: string; participant_token: string }> = [];
      for (const [i, client] of clients.entries()) {
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
        const result = await client.callTool({ name: 'mupit_register', arguments: {
          registration_key: `auto-http-registration-${i}`, introduction: i === 0 ? INTRO_A : INTRO_B,
          preferences: i === 0 ? PREFS_A : PREFS_B, adult_attested: true, publication_confirmed: true,
        } });
        identities.push(result.structuredContent as typeof identities[number]);
      }
      const client = clients[0]!;
      const start = await client.callTool({ name: 'mupit_start', arguments: {} });
      expect((start.structuredContent as Record<string, unknown>)?.automatic_mediation).toBe(true);
      const opened = await client.callTool({ name: 'mupit_open_conversation', arguments: {
        participant_token: identities[0]!.participant_token, target_participant_id: identities[1]!.participant_id,
        request_id: 'auto-http-opener-1', kind: 'question', body: 'What weekly rhythm works for your person?',
      } });
      const deadline = Date.now() + 5000;
      let hasMediator = false;
      while (Date.now() < deadline) {
        const read = await client.callTool({ name: 'mupit_read_conversation', arguments: {
          participant_token: identities[0]!.participant_token, conversation_id: (opened.structuredContent as Record<string, unknown>).conversation_id,
        } });
        hasMediator = ((read.structuredContent as Record<string, unknown>)?.messages as Array<{ sender_role: string }>).some(m => m.sender_role === 'mupit');
        if (hasMediator) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(hasMediator).toBe(true);
    } finally {
      await Promise.all(clients.map(c => c.close().catch(() => {})));
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('serves healthz + MCP initialize/list/call over Streamable HTTP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupit-http-'));
    const cfg = testConfig(join(dir, 'http.db'), { port: 0, facilitatorMode: 'mock', demoMode: true });
    let server: Awaited<ReturnType<typeof startServer>>;
    try {
      server = await startServer(cfg);
    } catch (err) {
      if (err instanceof Error && /EPERM|EACCES|operation not permitted/i.test(err.message)) {
        console.warn('SKIP http-smoke: listening sockets are blocked in this environment (runs in CI / on dev machines).');
        rmSync(dir, { recursive: true, force: true });
        return;
      }
      throw err;
    }
    try {
      const healthRes = await fetch(server.url.replace(/\/mcp\/?$/, '/healthz'));
      expect(healthRes.ok).toBe(true);
      const health = (await healthRes.json()) as { ok: boolean; server: string };
      expect(health.ok).toBe(true);
      expect(health.server).toBe('mupit');

      // Raw initialize POST first: surfaces the exact status/body on failure.
      const rawRes = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-smoke-raw', version: '0' } },
        }),
      });
      const rawBody = await rawRes.text();
      if (!rawRes.ok) throw new Error(`raw initialize POST -> HTTP ${rawRes.status} body=${JSON.stringify(rawBody.slice(0, 500))}`);

      const client = new Client({ name: 'http-smoke', version: '0.0.0-test' });
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
      try {
        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);
        expect(names).toContain('mupit_start');
        expect(names).toContain('mupit_register');
        expect(names).toHaveLength(19);
        const res = (await client.callTool({ name: 'mupit_start', arguments: {} })) as {
          structuredContent?: Record<string, unknown>;
        };
        expect(res.structuredContent?.ok).toBe(true);
        expect(res.structuredContent?.server_version).toBe('0.1.0');

        // Independent clients may reuse JSON-RPC IDs concurrently. Requests
        // must not share transport state or collide with the first client.
        await Promise.all(Array.from({ length: 3 }, async (_, i) => {
          const other = new Client({ name: `http-smoke-${i}`, version: '0.0.0-test' });
          try {
            await other.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            for (let n = 0; n < 2; n++) {
              const reply = await other.callTool({ name: 'mupit_start', arguments: {} });
              expect((reply.structuredContent as Record<string, unknown>)?.server_version).toBe('0.1.0');
            }
          } finally {
            await other.close().catch(() => {});
          }
        }));
      } finally {
        await client.close().catch(() => {});
      }
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
