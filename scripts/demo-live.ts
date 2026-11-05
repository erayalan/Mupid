import { existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { unwrap } from '../demo/agents/client.js';

/**
 * `npm run demo:live` — REAL Meta-model facilitator smoke test with fictional
 * data. Requires META_API_KEY (or MODEL_API_KEY). Never falls back to mock:
 * without credentials it exits with a clear setup error.
 * Asserts structure + evidence grounding, never exact strings.
 */
const PORT = 3098;
const DB = 'demo/state/flow-live.db';

class P {
  static n = 0;
  constructor(private c: Client, readonly token: string, readonly id: string) {}
  async call(tool: string, args: Record<string, unknown>, mutating = false): Promise<Record<string, unknown>> {
    P.n += 1;
    const full: Record<string, unknown> = { participant_token: this.token, ...args };
    if (mutating) full.request_id = `live-${P.n}-${randomBytes(8).toString('hex')}`;
    return unwrap(tool, await this.c.callTool({ name: tool, arguments: full }));
  }
  async close(): Promise<void> { await this.c.close().catch(() => {}); }
}

async function main(): Promise<void> {
  if (!process.env.META_API_KEY?.trim() && !process.env.MODEL_API_KEY?.trim()) {
    console.error('demo:live requires META_API_KEY (or MODEL_API_KEY). Get one from the Meta developer platform. Refusing to silently use mock output.');
    process.exit(2);
  }
  for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(DB + s)) unlinkSync(DB + s);
  const cfg = loadConfig({ ...process.env, MUPIT_PORT: String(PORT), MUPIT_DB_PATH: DB, MUPIT_DEMO_MODE: '1' });
  if (cfg.facilitatorMode !== 'live') throw new Error('demo:live requires live facilitator mode.');
  const { close, url } = await startServer(cfg);
  console.log(`[LIVE demo] server=${url} model=${cfg.metaModel}`);
  const t0 = Date.now();
  try {
    const mk = async (tag: string, intro: unknown, prefs: unknown): Promise<P> => {
      const c = new Client({ name: `livedemo-${tag}`, version: '0.1.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(url)));
      const r = unwrap('mupit_register', await c.callTool({
        name: 'mupit_register',
        arguments: {
          registration_key: `livedemo-${tag}-${randomBytes(16).toString('hex')}`,
          introduction: intro, preferences: prefs, adult_attested: true, publication_confirmed: true, simulated: true,
        },
      }));
      return new P(c, String(r.participant_token), String(r.participant_id));
    };
    const A = await mk('a', {
      age: 30, about_me: 'Live-demo hiker from Portland. Non-smoker, remote worker, guards weeknight downtime.',
      looking_for: 'A long-term partner; shared values over shared hobbies.',
      relationship_intent: 'long_term', region: 'Portland', open_to_long_distance: true,
      interests: ['hiking'], values: ['independence'], lifestyle: [], dealbreakers: [],
    }, { age_min: 26, age_max: 38, accepted_intents: ['dating', 'long_term'], same_region_only: false });
    const B = await mk('b', {
      age: 32, about_me: 'Live-demo gamer from Seattle. Calm routine, non-smoker, loves long novels.',
      looking_for: 'A long-term partner with a rich inner life.',
      relationship_intent: 'long_term', region: 'Seattle', open_to_long_distance: true,
      interests: ['novels'], values: ['independence'], lifestyle: [], dealbreakers: [],
    }, { age_min: 26, age_max: 40, accepted_intents: ['dating', 'long_term'], same_region_only: false });

    const opened = await A.call('mupit_open_conversation', {
      target_participant_id: B.id, kind: 'question',
      body: '[SCRIPTED harness line] What does a good week look like for your person?',
    }, true);
    const conv = String(opened.conversation_id);
    await B.call('mupit_send_message', { conversation_id: conv, kind: 'answer', body: '[SCRIPTED harness line] Quiet weeknights, game night Fridays, and open weekends for trips.' }, true);

    const read1 = await A.call('mupit_read_conversation', { conversation_id: conv });
    const f1 = await A.call('mupit_facilitate', { conversation_id: conv, expected_revision: (read1 as { revision: number }).revision }, true);
    console.log('\n--- LIVE facilitator turn #1 ---');
    console.log(JSON.stringify({ status: f1.status, action: f1.action, provider: f1.provider, message_id: f1.message_id }, null, 2));
    if (f1.status !== 'complete') throw new Error(`expected complete, got ${String(f1.status)}: ${JSON.stringify(f1)}`);
    if ((f1.provider as { label: string }).label !== 'live-meta') throw new Error('provider not live-meta');
    const readBack = await B.call('mupit_read_conversation', { conversation_id: conv });
    const msgs = readBack.messages as Array<{ sender_role: string; body: string }>;
    const mupitMsg = msgs.find((m) => m.sender_role === 'mupit');
    if (!mupitMsg) throw new Error('no mupit message visible to B');
    console.log('\nMupit question (REAL model output):\n' + mupitMsg.body + '\n');
    if (mupitMsg.body.length < 60) throw new Error('model output suspiciously short');
    if (!/[?]/.test(mupitMsg.body) && String(f1.action) === 'ask_agents') throw new Error('ask_agents output has no question');

    await A.call('mupit_send_message', { conversation_id: conv, kind: 'answer', body: '[SCRIPTED harness line] For us: independent weeknights, shared weekends, steady pace.' }, true);
    const read2 = await A.call('mupit_read_conversation', { conversation_id: conv });
    const f2 = await A.call('mupit_facilitate', { conversation_id: conv, expected_revision: (read2 as { revision: number }).revision }, true);
    console.log('--- LIVE facilitator turn #2 ---');
    console.log(JSON.stringify({ status: f2.status, action: f2.action, reasons: f2.reasons, tensions: f2.tensions, unknowns: f2.unknowns }, null, 2));
    if (f2.status !== 'complete') throw new Error(`expected complete, got ${String(f2.status)}`);
    const refs = (f2.evidence_refs as string[]) ?? [];
    const knownIds = new Set((read2.messages as Array<{ message_id: string }>).map((m) => m.message_id));
    for (const ref of refs) {
      if (ref.startsWith('m_') && !knownIds.has(ref)) throw new Error(`evidence ref ${ref} does not exist in thread`);
    }
    console.log(`\n[LIVE demo] PASS in ${((Date.now() - t0) / 1000).toFixed(1)}s: real ${cfg.metaModel} turns with validated evidence grounding.`);
    await A.close(); await B.close();
  } finally {
    await close();
  }
}

const invokedDirectly = process.argv[1]?.endsWith('/demo-live.ts') || process.argv[1]?.endsWith('/demo-live.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`demo:live failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
