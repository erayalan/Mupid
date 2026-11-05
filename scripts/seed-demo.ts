import { existsSync, unlinkSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEMO_AGENTS, demoDbPath, demoUrl, waitForHealth } from './demo-env.js';
import { loadFixture, loadState, saveState, unwrap } from '../demo/agents/client.js';
import { newAgentState } from '../demo/agents/types.js';

/**
 * `npm run seed:demo` — register fictional adult participants through MCP
 * (never direct DB inserts), retaining credentials in demo/state (0600,
 * gitignored). Idempotent and restart-safe: existing valid credentials are
 * kept; only missing/invalid ones re-register with a FRESH identity.
 *
 * Refuses to run unless the target server reports demoMode=true, and
 * `--reset` deletes ONLY the explicitly named demo database + state.
 */
export async function seedDemo(url: string, agents: string[]): Promise<void> {
  const health = await waitForHealth(url, 15_000);
  if (health.demoMode !== true) {
    throw new Error(`Refusing to seed: ${url} does not report demoMode=true. Start the demo server (demo:up) so simulated provenance applies.`);
  }
  for (const name of agents) {
    const fixture = loadFixture(name);
    const existing = loadState(name);
    if (existing?.participant_id && existing.token) {
      // Verify credentials still valid against this database.
      const probe = new Client({ name: 'mupit-seed-probe', version: '0.1.0' });
      await probe.connect(new StreamableHTTPClientTransport(new URL(url)));
      try {
        const res = unwrap('mupit_get_self', await probe.callTool({
          name: 'mupit_get_self', arguments: { participant_token: existing.token },
        }));
        if (res.participant_id === existing.participant_id) {
          console.log(`seed: ${name} already registered as ${existing.participant_id} (kept)`);
          await probe.close();
          continue;
        }
      } catch {
        console.log(`seed: ${name} saved credentials invalid for this DB; re-registering fresh`);
      }
      await probe.close();
    }
    const client = new Client({ name: 'mupit-seed', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    try {
      const registrationKey = `seed-${name}-${randomBytes(24).toString('hex')}`;
      const res = unwrap('mupit_register', await client.callTool({
        name: 'mupit_register',
        arguments: {
          registration_key: registrationKey,
          introduction: fixture.introduction,
          preferences: fixture.preferences,
          adult_attested: true,
          publication_confirmed: true,
          simulated: true,
        },
      }));
      const state = newAgentState(name);
      state.participant_id = String(res.participant_id);
      state.token = String(res.participant_token);
      state.registration_key = registrationKey;
      saveState(state);
      console.log(`seed: ${name} registered as ${state.participant_id} (simulated; credentials in demo/state/${name}.json)`);
    } finally {
      await client.close();
    }
  }
}

function resetDemoDb(): void {
  const dbPath = demoDbPath();
  if (!dbPath.includes('demo')) {
    throw new Error(`Refusing --reset: MUPIT_DEMO_DB_PATH "${dbPath}" does not look like a demo database.`);
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = dbPath + suffix;
    if (existsSync(p)) {
      unlinkSync(p);
      console.log(`reset: deleted ${p}`);
    }
  }
  const stateDir = process.env.MUPIT_DEMO_STATE_DIR ?? 'demo/state';
  if (existsSync(stateDir)) {
    for (const f of readdirSync(stateDir)) {
      if (f.endsWith('.json')) {
        unlinkSync(`${stateDir}/${f}`);
        console.log(`reset: deleted ${stateDir}/${f}`);
      }
    }
  }
}

const invokedDirectly = process.argv[1]?.endsWith('/seed-demo.ts') || process.argv[1]?.endsWith('/seed-demo.js');
if (invokedDirectly) {
  if (process.argv.includes('--reset')) resetDemoDb();
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);
  seedDemo(demoUrl(), only ?? DEMO_AGENTS).catch((err) => {
    const status = (err as { code?: unknown })?.code;
    console.error(`seed:demo failed: ${err instanceof Error ? err.message : String(err)}${status !== undefined ? ` (HTTP status ${String(status)})` : ''}`);
    process.exit(1);
  });
}
