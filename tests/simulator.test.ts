import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/tools.js';
import { SimClient, loadFixture, loadState, saveState } from '../demo/agents/client.js';
import { newAgentState } from '../demo/agents/types.js';
import { runAgentTick, type TickOpts } from '../demo/agents/runner.js';
import { generateLiveReply } from '../demo/agents/reasoning.js';
import { INTRO_A, INTRO_B, PREFS_A, PREFS_B, TClient, makeTestContext, registerUser, req, type TestContext } from './helpers.js';

async function simConnect(ctx: TestContext, name: string): Promise<SimClient> {
  const mcp = createMcpServer(ctx.app);
  const [x, y] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: `sim-${name}`, version: '0.0.0-test' });
  await Promise.all([mcp.connect(x), client.connect(y)]);
  return SimClient.connectWith(name, client);
}

function tickOpts(ctx: TestContext, lines: string[]): TickOpts {
  return {
    url: 'in-memory', live: false, discover: false, llm: null,
    maxThreadsPerTick: 5, maxLlmCallsPerTick: 0, maxResponsesPerThread: 12,
    log: (l) => lines.push(l),
    connect: (name) => simConnect(ctx, name),
  };
}

describe('simulator harness (acceptance additions)', () => {
  it('scripted sim advances a real thread over MCP, counters/accepts via fixture, and completes release with honest provenance', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mupit-simstate-'));
    const prevStateDir = process.env.MUPIT_DEMO_STATE_DIR;
    process.env.MUPIT_DEMO_STATE_DIR = stateDir;
    const ctx = makeTestContext(); // demoMode=true
    try {
      // Register the wren fixture participant through MCP (provisioning boundary).
      const seed = await TClient.connect(ctx, 'seed');
      const wrenFixture = loadFixture('wren');
      let wrenId = '';
      try {
        const r = await seed.call('mupit_register', {
          registration_key: `simtest-wren-${Date.now()}`, introduction: wrenFixture.introduction,
          preferences: wrenFixture.preferences, adult_attested: true, publication_confirmed: true, simulated: true,
        });
        wrenId = String(r.participant_id);
        const st = newAgentState('wren');
        st.participant_id = wrenId;
        st.token = String(r.participant_token);
        st.registration_key = 'simtest-wren';
        saveState(st);
        expect(loadState('wren')?.participant_id).toBe(wrenId);
      } finally {
        await seed.close();
      }
      const wrenRow = ctx.db.prepare('SELECT is_simulated FROM participants WHERE id = ?').get(wrenId) as { is_simulated: number };
      expect(wrenRow.is_simulated).toBe(1);

      // Real user R opens a thread with wren.
      const r = await TClient.connect(ctx, 'real');
      const R = await registerUser(r, 'real', INTRO_A, PREFS_A);
      const opened = await r.call('mupit_open_conversation', {
        participant_token: R.token, request_id: req(), target_participant_id: wrenId, kind: 'question', body: 'What does a good week look like?',
      });
      const conv = String(opened.conversation_id);
      const lines: string[] = [];
      const countMsgs = (): number =>
        (ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conv) as { n: number }).n;

      await runAgentTick('wren', tickOpts(ctx, lines)); // reply #1 + facilitate
      expect(countMsgs()).toBe(3); // opener + scripted reply + mock mupit turn
      expect(lines.some((l) => l.includes('replied'))).toBe(true);
      expect(lines.some((l) => l.includes('facilitate'))).toBe(true);

      await r.call('mupit_send_message', { participant_token: R.token, request_id: req(), conversation_id: conv, kind: 'answer', body: 'Independent weeknights, shared weekends here.' });
      await runAgentTick('wren', tickOpts(ctx, lines)); // reply #2 + assessment
      const assessment = ctx.db.prepare('SELECT assessment FROM assessments WHERE conversation_id = ? AND participant_id = ?').get(conv, wrenId) as { assessment: string };
      expect(assessment.assessment).toBe('promising');

      // R proposes instagram; wren's FIXTURE (not an LLM) accepts.
      await r.call('mupit_propose_connection', {
        participant_token: R.token, request_id: req(), conversation_id: conv, expected_version: 0, channel: 'instagram', human_confirmed: true,
      });
      await runAgentTick('wren', tickOpts(ctx, lines)); // accept -> awaiting_contacts
      await runAgentTick('wren', tickOpts(ctx, lines)); // submit fixture contact
      const submitted = ctx.db.prepare('SELECT participant_id, provenance FROM contact_submissions WHERE conversation_id = ?').all(conv) as Array<{
        participant_id: string; provenance: string;
      }>;
      expect(submitted).toEqual([{ participant_id: wrenId, provenance: 'simulated_fixture' }]);

      // R submits -> released; wren records completion on next tick.
      await r.call('mupit_submit_contact', {
        participant_token: R.token, request_id: req(), conversation_id: conv, proposal_version: 1,
        channel: 'instagram', contact_value: 'real.person', human_confirmed: true,
      });
      await runAgentTick('wren', tickOpts(ctx, lines));
      expect(loadState('wren')?.completed_releases).toContain(conv);
      const approvals = JSON.parse(
        (ctx.db.prepare('SELECT approvals_json FROM connection_proposals WHERE conversation_id = ?').get(conv) as { approvals_json: string }).approvals_json,
      ) as Record<string, { provenance: string }>;
      expect(approvals[R.id]?.provenance).toBe('human_reported_by_personal_agent');
      expect(approvals[wrenId]?.provenance).toBe('simulated_fixture');

      // Restart-safety: a tick with no new input sends nothing and duplicates nothing.
      const before = countMsgs();
      await runAgentTick('wren', tickOpts(ctx, lines));
      expect(countMsgs()).toBe(before);

      // Stopping the simulator leaves the core backend usable by ordinary clients.
      const still = await r.call('mupit_list_conversations', { participant_token: R.token });
      expect((still.conversations as unknown[]).length).toBe(1);
      await r.close();
    } finally {
      ctx.close();
      if (prevStateDir === undefined) delete process.env.MUPIT_DEMO_STATE_DIR;
      else process.env.MUPIT_DEMO_STATE_DIR = prevStateDir;
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('background agents prepare three introductions without a player turn, retain channel choices, and release only the selected contact', async () => {
    const statePath = mkdtempSync(join(tmpdir(), 'mupit-background-'));
    const previous = process.env.MUPIT_DEMO_STATE_DIR;
    process.env.MUPIT_DEMO_STATE_DIR = statePath;
    const ctx = makeTestContext({ backgroundDemo: true });
    const player = await TClient.connect(ctx, 'background-player');
    try {
      const ids: Record<string, string> = {};
      for (const name of ['wren', 'sam', 'leo', 'jules']) {
        const fixture = loadFixture(name);
        const registered = await registerUser(player, `background-${name}`, fixture.introduction, fixture.preferences, true);
        const state = newAgentState(name);
        state.participant_id = registered.id;
        state.token = registered.token;
        state.registration_key = registered.regKey;
        saveState(state);
        ids[name] = registered.id;
      }
      // The player has only registered; no discovery, opener, reply, or consent.
      const human = await registerUser(player, 'background-human');
      const opts = { ...tickOpts(ctx, []), background: true, discover: true };
      for (const name of ['wren', 'sam', 'leo', 'jules']) await runAgentTick(name, opts);
      const list = await player.call('mupit_list_conversations', { participant_token: human.token });
      const convs = list.conversations as Array<{ conversation_id: string; counterpart_id: string }>;
      expect(convs).toHaveLength(3);
      expect(convs.map(c => c.counterpart_id).sort()).toEqual([ids.wren, ids.sam, ids.leo].sort());
      const snapshots = new Map<string, number>();
      for (const conv of convs) {
        const read = await player.call('mupit_read_conversation', { participant_token: human.token, conversation_id: conv.conversation_id });
        const messages = read.messages as Array<{ body: string }>;
        const text = messages.map(m => m.body).join(' ');
        expect(text).toContain('SIMULATED fixture introduction');
        expect(text).toContain('Preferred contact channel:');
        expect(text).not.toMatch(/@example\.com|wren\.example|sam\.example|leo\.example/);
        expect(read.connection_proposal).toBeNull();
        if (conv.counterpart_id === ids.sam) expect(text).toContain('does not want children');
        snapshots.set(conv.conversation_id, messages.filter(m => m.body.includes('SIMULATED fixture introduction')).length);
      }
      // Reloaded worker states may continue the facilitator conversation, but
      // must not create more pair threads or duplicate introductions.
      for (const name of ['wren', 'sam', 'leo', 'jules']) await runAgentTick(name, opts);
      const again = await player.call('mupit_list_conversations', { participant_token: human.token });
      expect(again.conversations).toHaveLength(3);
      for (const conv of convs) {
        const read = await player.call('mupit_read_conversation', { participant_token: human.token, conversation_id: conv.conversation_id });
        expect((read.messages as Array<{ body: string }>).filter(m => m.body.includes('SIMULATED fixture introduction'))).toHaveLength(snapshots.get(conv.conversation_id)!);
      }
      // Choose Wren and Instagram, even though Wren prefers email. Channel
      // willingness alone did not approve a proposal or expose any contacts.
      const selected = convs.find(c => c.counterpart_id === ids.wren)!;
      const args = { participant_token: human.token, conversation_id: selected.conversation_id };
      await player.fails('mupit_get_connection_contact', { ...args, proposal_version: 1 }, 'CONTACT_NOT_RELEASED');
      await player.call('mupit_propose_connection', { ...args, request_id: req(), expected_version: 0, channel: 'instagram', human_confirmed: true });
      await runAgentTick('wren', opts); // fixture accepts current channel
      await runAgentTick('wren', opts); // fixture submits own value
      await player.fails('mupit_get_connection_contact', { ...args, proposal_version: 1 }, 'CONTACT_NOT_RELEASED');
      await player.call('mupit_submit_contact', { ...args, request_id: req(), proposal_version: 1, channel: 'instagram', contact_value: 'alex.demo', human_confirmed: true });
      const contact = await player.call('mupit_get_connection_contact', { ...args, proposal_version: 1 });
      expect(contact.contact_value).toBe('wren.example');
      expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM connection_proposals').get() as { n: number }).n).toBe(1);
    } finally {
      await player.close();
      ctx.close();
      if (previous === undefined) delete process.env.MUPIT_DEMO_STATE_DIR;
      else process.env.MUPIT_DEMO_STATE_DIR = previous;
      rmSync(statePath, { recursive: true, force: true });
    }
  });

  it('prepares three women for a registered man seeking women without an extra player turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mupit-women-roster-'));
    const previous = process.env.MUPIT_DEMO_STATE_DIR;
    process.env.MUPIT_DEMO_STATE_DIR = dir;
    const ctx = makeTestContext();
    const client = await TClient.connect(ctx, 'male-player');
    try {
      const ids: string[] = [];
      for (const name of ['mira', 'ivy', 'elena']) {
        const fixture = loadFixture(name);
        const registered = await registerUser(client, name, fixture.introduction, fixture.preferences, true);
        const state = newAgentState(name);
        state.participant_id = registered.id; state.token = registered.token; state.registration_key = registered.regKey;
        saveState(state); ids.push(registered.id);
      }
      const human = await registerUser(client, 'male-player', { ...INTRO_A, age: 38 }, {
        ...PREFS_A, gender: 'man', accepted_genders: ['woman'], age_min: 30, age_max: 42,
      });
      const opts = { ...tickOpts(ctx, []), background: true, discover: true };
      for (const name of ['mira', 'ivy', 'elena']) await runAgentTick(name, opts);
      const list = await client.call('mupit_list_conversations', { participant_token: human.token });
      const convs = list.conversations as Array<{ conversation_id: string; counterpart_id: string }>;
      expect(convs).toHaveLength(3);
      expect(convs.map(c => c.counterpart_id).sort()).toEqual(ids.sort());
      for (const conv of convs) {
        const read = await client.call('mupit_read_conversation', { participant_token: human.token, conversation_id: conv.conversation_id });
        const bodies = (read.messages as Array<{ body: string }>).map(m => m.body).join(' ');
        expect(bodies).toContain('Preferred contact channel:');
        expect(bodies).not.toContain('@example.com');
        expect(read.connection_proposal).toBeNull();
      }
    } finally {
      await client.close(); ctx.close();
      if (previous === undefined) delete process.env.MUPIT_DEMO_STATE_DIR;
      else process.env.MUPIT_DEMO_STATE_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('simulated consent is rejected for real identities and outside demo mode', async () => {
    const ctx = makeTestContext();
    try {
      const a = await TClient.connect(ctx, 'a');
      const b = await TClient.connect(ctx, 'b');
      try {
        const A = await registerUser(a, 'a', INTRO_A, PREFS_A);
        const B = await registerUser(b, 'b', INTRO_B, PREFS_B);
        const opened = await a.call('mupit_open_conversation', {
          participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'hi',
        });
        const conv = String(opened.conversation_id);
        await a.fails('mupit_propose_connection', {
          participant_token: A.token, request_id: req(), conversation_id: conv, expected_version: 0,
          channel: 'email', human_confirmed: true, demo_simulated_consent: true,
        }, 'FORBIDDEN');
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx.close();
    }
    // Outside demo mode even a would-be simulated identity cannot use fixture consent.
    const ctx2 = makeTestContext({ demoMode: false });
    try {
      const a = await TClient.connect(ctx2, 'a');
      const b = await TClient.connect(ctx2, 'b');
      try {
        const A = await registerUser(a, 'a', INTRO_A, PREFS_A, true); // flag ignored outside demo mode
        const B = await registerUser(b, 'b', INTRO_B, PREFS_B);
        const row = ctx2.db.prepare('SELECT is_simulated FROM participants WHERE id = ?').get(A.id) as { is_simulated: number };
        expect(row.is_simulated).toBe(0);
        const opened = await a.call('mupit_open_conversation', {
          participant_token: A.token, request_id: req(), target_participant_id: B.id, kind: 'question', body: 'hi',
        });
        await a.fails('mupit_propose_connection', {
          participant_token: A.token, request_id: req(), conversation_id: String(opened.conversation_id),
          expected_version: 0, channel: 'email', human_confirmed: true, demo_simulated_consent: true,
        }, 'FORBIDDEN');
      } finally {
        await a.close(); await b.close();
      }
    } finally {
      ctx2.close();
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('live sim reasoning isolates per-agent context (own persona + thread only; no tokens/contacts)', async () => {
    const fixture = loadFixture('wren');
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kind: 'answer', body: 'stubbed persona reply', needs_human: false }) } }] }), { status: 200 });
    });
    const plan = await generateLiveReply(
      { apiKey: 'test-key', baseUrl: 'https://api.test/v1', model: 'test-model', timeoutMs: 5000 },
      fixture,
      {
        conversation_id: 'c_test', counterpart_id: 'p_other',
        counterpart_intro: { about_me: 'hello-thread-marker' },
        messages: [{ sender_role: 'personal_agent', kind: 'question', body: 'what pace do you like?', seq: 1 }],
      },
      { topic: 'pace', answer: 'Wren says: steady and unhurried.' },
    );
    expect(plan.body).toBe('stubbed persona reply');
    expect(bodies).toHaveLength(1);
    const blob = JSON.stringify(bodies[0]);
    expect(blob).toContain('Wren'); // own persona
    expect(blob).toContain('hello-thread-marker'); // this thread
    expect(blob).toContain('steady and unhurried'); // approved fixture fact
    expect(blob).not.toContain('wren@example.com'); // contacts never in prompts
    expect(blob).not.toContain('participant_token');
    expect(blob).not.toContain('tabletop'); // Sam's persona must not leak into Wren's context
  });
});
