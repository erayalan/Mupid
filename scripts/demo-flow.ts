import { existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';
import { unwrap } from '../demo/agents/client.js';

/**
 * `npm run demo` — DETERMINISTIC mock protocol demonstration.
 * Everything runs through the real MCP transport + SQLite + auth + release
 * logic, but the facilitator is the deterministic mock (explicitly labeled)
 * and both personal agents are scripted harness lines (NOT LLM reasoning).
 * For real Meta inference see `npm run demo:live`.
 */
const PORT = 3097;
const DB = 'demo/state/flow.db';

const A_INTRO = {
  age: 30, about_me: 'Flow-demo hiker from Portland who cooks and photographs weekends outdoors. Non-smoker.',
  looking_for: 'A long-term partner with their own passions; shared values over shared hobbies.',
  relationship_intent: 'long_term', region: 'Portland', open_to_long_distance: true,
  interests: ['hiking'], values: ['independence', 'directness'], lifestyle: ['non-smoker'], dealbreakers: ['smoking'],
};
const A_PREFS = { age_min: 26, age_max: 38, gender: 'woman', accepted_genders: ['man'], accepted_intents: ['dating', 'long_term'], same_region_only: false };
const B_INTRO = {
  age: 32, about_me: 'Flow-demo bookworm and tabletop gamer from Seattle. Calm routine, non-smoker.',
  looking_for: 'A long-term partner with a rich inner life; different hobbies are fine.',
  relationship_intent: 'long_term', region: 'Seattle', open_to_long_distance: true,
  interests: ['novels'], values: ['independence', 'directness'], lifestyle: ['non-smoker'], dealbreakers: ['smoking'],
};
const B_PREFS = { age_min: 27, age_max: 40, gender: 'man', accepted_genders: ['woman'], accepted_intents: ['dating', 'long_term'], same_region_only: false };

class Flow {
  static n = 0;
  constructor(private c: Client, readonly token: string, readonly id: string, readonly tag: string) {}
  static async register(url: string, tag: string, intro: unknown, prefs: unknown, simulated: boolean): Promise<Flow> {
    const c = new Client({ name: `flow-${tag}`, version: '0.1.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url)));
    const r = unwrap('mupit_register', await c.callTool({
      name: 'mupit_register',
      arguments: {
        registration_key: `flow-${tag}-${randomBytes(16).toString('hex')}`,
        introduction: intro, preferences: prefs, adult_attested: true, publication_confirmed: true, simulated,
      },
    }));
    return new Flow(c, String(r.participant_token), String(r.participant_id), tag);
  }
  async call(tool: string, args: Record<string, unknown>, mutating = false): Promise<Record<string, unknown>> {
    Flow.n += 1;
    const full: Record<string, unknown> = { participant_token: this.token, ...args };
    if (mutating) full.request_id = `flow-${Flow.n}-${randomBytes(8).toString('hex')}`;
    return unwrap(tool, await this.c.callTool({ name: tool, arguments: full }));
  }
  async close(): Promise<void> { await this.c.close().catch(() => {}); }
}

function step(n: string): void { console.log(`\n=== ${n} ===`); }
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main(): Promise<void> {
  for (const s of ['', '-wal', '-shm', '-journal']) if (existsSync(DB + s)) unlinkSync(DB + s);
  const cfg = loadConfig({ ...process.env, MUPIT_PORT: String(PORT), MUPIT_DB_PATH: DB, MUPIT_DEMO_MODE: '1', MUPIT_FACILITATOR_MODE: 'mock' });
  const { close, url } = await startServer(cfg);
  console.log(`[MOCK protocol demo] server=${url} facilitator=MOCK (explicit)`);
  try {
    const A = await Flow.register(url, 'alex', A_INTRO, A_PREFS, false);
    const B = await Flow.register(url, 'sam', B_INTRO, B_PREFS, true);
    step('1. discovery (reciprocal filters)');
    const disc = await A.call('mupit_discover', {});
    const found = ((disc.candidates as Array<{ participant_id: string }>) ?? []).some((c) => c.participant_id === B.id);
    assert(found, 'A discovers B as eligible');

    step('2. open thread + scripted exchange (harness lines, NOT LLM reasoning)');
    const opened = await A.call('mupit_open_conversation', {
      target_participant_id: B.id, kind: 'question',
      body: '[SCRIPTED] Hi! What does a good week look like for your person?',
    }, true);
    const conv = String(opened.conversation_id);
    assert(opened.created === true, 'canonical thread created');
    await B.call('mupit_send_message', { conversation_id: conv, kind: 'answer', body: '[SCRIPTED] Sam-like weeks: game night, reading, volunteering. Weekends free for trips.' }, true);

    step('3. mock facilitator turn #1 (labeled mock output)');
    const read1 = await A.call('mupit_read_conversation', { conversation_id: conv });
    const f1 = await A.call('mupit_facilitate', { conversation_id: conv, expected_revision: (read1 as { revision: number }).revision }, true);
    assert(f1.status === 'complete', `facilitator turn committed (action=${String(f1.action)})`);
    assert((f1.provider as { label: string }).label === 'mock', 'provider honestly labeled mock');
    console.log(`  mock question: ${JSON.stringify((f1 as { message_id: string }).message_id)} action=${String(f1.action)}`);

    step('4. second exchange + turn #2');
    await B.call('mupit_send_message', { conversation_id: conv, kind: 'answer', body: '[SCRIPTED] On pace: slow and easy suits us. Portland-Seattle weekends are fine.' }, true);
    const read2 = await A.call('mupit_read_conversation', { conversation_id: conv });
    const f2 = await A.call('mupit_facilitate', { conversation_id: conv, expected_revision: (read2 as { revision: number }).revision }, true);
    assert(f2.status === 'complete', `second turn committed (action=${String(f2.action)})`);
    await A.call('mupit_set_assessment', { conversation_id: conv, assessment: 'promising', rationale: 'Scripted demo: two grounded exchanges, no conflicts.' }, true);

    step('5. channel negotiation: instagram countered with email');
    const p1 = await A.call('mupit_propose_connection', { conversation_id: conv, expected_version: 0, channel: 'instagram', human_confirmed: true }, true);
    assert((p1 as { version: number }).version === 1 && (p1 as { status: string }).status === 'negotiating', 'v1 instagram negotiating, A approved');
    const p2 = await B.call('mupit_propose_connection', { conversation_id: conv, expected_version: 1, channel: 'email', human_confirmed: true, demo_simulated_consent: true }, true);
    assert((p2 as { version: number }).version === 2, 'counter created v2 email; v1 invalidated');
    const staleSubmitFails = await B.call('mupit_submit_contact', {
      conversation_id: conv, proposal_version: 1, channel: 'instagram', contact_value: 'stale@example.com', human_confirmed: true, demo_simulated_consent: true,
    }, true).then(() => false, () => true);
    assert(staleSubmitFails, 'stale v1 submission rejected');
    const p3 = await A.call('mupit_respond_connection', { conversation_id: conv, proposal_version: 2, decision: 'accept', human_confirmed: true }, true);
    assert((p3 as { status: string }).status === 'awaiting_contacts', 'v2 email mutually accepted -> awaiting_contacts');

    step('6. one-sided submission stays withheld');
    const s1 = await A.call('mupit_submit_contact', {
      conversation_id: conv, proposal_version: 2, channel: 'email', contact_value: 'alex.flow@example.com', human_confirmed: true,
    }, true);
    assert(s1.released === false, 'no release after one submission');
    const earlyReadFails = await B.call('mupit_get_connection_contact', { conversation_id: conv, proposal_version: 2 }).then(() => false, () => true);
    assert(earlyReadFails, 'counterpart contact unreadable before mutual release');

    step('7. mutual release (atomic)');
    const s2 = await B.call('mupit_submit_contact', {
      conversation_id: conv, proposal_version: 2, channel: 'email', contact_value: 'sam.flow@example.com', human_confirmed: true, demo_simulated_consent: true,
    }, true);
    assert(s2.released === true, 'release on second submission');
    const ca = await A.call('mupit_get_connection_contact', { conversation_id: conv, proposal_version: 2 });
    const cb = await B.call('mupit_get_connection_contact', { conversation_id: conv, proposal_version: 2 });
    assert(ca.contact_value === 'sam.flow@example.com', 'A reads B’s released email');
    assert(cb.contact_value === 'alex.flow@example.com', 'B reads A’s released email');

    step('8. negative case: hard-filter mismatch excluded + decline closes');
    const D = await Flow.register(url, 'theo', {
      age: 34, about_me: 'Flow-demo casual dater from Austin, honest about it.', looking_for: 'Something casual and local.',
      relationship_intent: 'casual', region: 'Austin', open_to_long_distance: false, interests: [], values: [], lifestyle: [], dealbreakers: [],
    }, { age_min: 25, age_max: 38, accepted_intents: ['casual'], same_region_only: true }, true);
    const disc2 = await A.call('mupit_discover', {});
    const seesD = ((disc2.candidates as Array<{ participant_id: string }>) ?? []).some((c) => c.participant_id === D.id);
    assert(!seesD, 'reciprocal mismatch (casual/Austin) excluded from discovery');
    const openFails = await A.call('mupit_open_conversation', { target_participant_id: D.id, kind: 'question', body: 'hi' }, true).then(() => false, () => true);
    assert(openFails, 'opening an ineligible pair fails with INELIGIBLE_PAIR');
    await A.close(); await B.close(); await D.close();

    console.log('\n[MOCK protocol demo] ALL CHECKS PASSED (mock-labeled; not LLM evidence)');
  } finally {
    await close();
  }
}

const invokedDirectly = process.argv[1]?.endsWith('/demo-flow.ts') || process.argv[1]?.endsWith('/demo-flow.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`demo failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
