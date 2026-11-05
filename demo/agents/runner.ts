import { SimClient, SimToolError, loadFixture } from './client.js';
import type { AgentState, PersonaFixture } from './types.js';
import { channelPreferenceText, contactFor, decideProposal, followupAnswer } from './decisions.js';
import { generateLiveReply, generateScriptedReply, type LiveOpts, type ThreadView } from './reasoning.js';

/**
 * Bounded decision loop for one simulated personal agent. Uses ONLY public
 * MCP tools (never backend internals): poll, list, read, send, facilitate,
 * assess, propose/respond/submit-contact, get-contact, discover.
 */

export interface TickOpts {
  url: string;
  live: boolean;
  discover: boolean;
  /** Proactive fixture introductions; no human token or automatic human consent. */
  background?: boolean;
  llm: LiveOpts | null;
  maxThreadsPerTick: number;
  maxLlmCallsPerTick: number;
  maxResponsesPerThread: number;
  log: (line: string) => void;
  /** Override client construction (tests inject in-memory MCP clients). */
  connect?: (name: string) => Promise<SimClient>;
}


function backgroundIntroduction(fixture: PersonaFixture): string {
  return `[SIMULATED fixture introduction] ${fixture.background_introduction} ${channelPreferenceText(fixture)}`;
}

interface Msg { seq: number; sender_role: string; sender_participant_id: string | null; addressed_participant_ids: string[]; kind: string; body: string; }

function asMsg(m: unknown): Msg {
  const x = m as Record<string, unknown>;
  return {
    seq: x.seq as number,
    sender_role: x.sender_role as string,
    sender_participant_id: (x.sender_participant_id as string | null) ?? null,
    addressed_participant_ids: (x.addressed_participant_ids as string[]) ?? [],
    kind: x.kind as string,
    body: x.body as string,
  };
}

function threadOf(state: AgentState, convId: string, counterpartId: string) {
  let t = state.threads[convId];
  if (!t) {
    t = { counterpart_id: counterpartId, last_seen_seq: 0, responses_sent: 0, script_index: 0, facilitated_revs: [], assessment: null, proposed: false };
    state.threads[convId] = t;
  }
  return t;
}

/** One facilitator attempt after fixture outreach, never a polling loop. */
async function facilitateBackground(sim: SimClient, convId: string, log: (s: string) => void, automatic: boolean): Promise<void> {
  if (automatic) return;
  const read = await sim.call('mupit_read_conversation', { conversation_id: convId });
  if (!read.facilitation_available) return;
  try {
    const result = await sim.call('mupit_facilitate', {
      conversation_id: convId, expected_revision: Number(read.revision),
    }, true);
    log(`background facilitation -> ${String(result.status)}`);
  } catch (err) {
    if (err instanceof SimToolError) log(`background facilitation failed: ${err.code}`);
    else throw err;
  }
}

async function handleProposals(
  sim: SimClient, fixture: PersonaFixture, convId: string, read: Record<string, unknown>, log: (s: string) => void,
): Promise<void> {
  const proposal = read.connection_proposal as null | {
    version: number; channel: string; status: string;
    approvals: Record<string, { approved: boolean }>;
    contact_submitted: Record<string, boolean>;
  };
  if (!proposal || proposal.status === 'released' || proposal.status === 'closed') return;
  const me = sim.state.participant_id;
  const iApproved = proposal.approvals[me]?.approved === true;
  const conv = read as { status: string };

  if (!iApproved && conv.status === 'active') {
    const d = decideProposal(fixture, proposal.channel);
    if (d.decision === 'accept') {
      await sim.call('mupit_respond_connection', {
        conversation_id: convId, proposal_version: proposal.version, decision: 'accept',
        human_confirmed: true, demo_simulated_consent: true,
      }, true);
      log(`${sim.name}: fixture ACCEPTED ${proposal.channel} v${proposal.version} (simulated_fixture)`);
    } else if (d.decision === 'counter') {
      await sim.call('mupit_propose_connection', {
        conversation_id: convId, expected_version: proposal.version, channel: d.channel,
        human_confirmed: true, demo_simulated_consent: true,
      }, true);
      log(`${sim.name}: fixture COUNTERED ${proposal.channel} -> ${d.channel} (simulated_fixture)`);
    } else {
      await sim.call('mupit_respond_connection', {
        conversation_id: convId, proposal_version: proposal.version, decision: 'decline',
        human_confirmed: true, demo_simulated_consent: true,
      }, true);
      log(`${sim.name}: fixture DECLINED ${proposal.channel} v${proposal.version} (simulated_fixture)`);
    }
    return;
  }
  // Approved by me: submit contact when both approved (awaiting_contacts).
  if (proposal.status === 'awaiting_contacts' && !proposal.contact_submitted[me]) {
    const value = contactFor(fixture, proposal.channel);
    if (!value) {
      log(`${sim.name}: no fixture contact for channel ${proposal.channel}; leaving unsubmitted`);
      return;
    }
    const res = await sim.call('mupit_submit_contact', {
      conversation_id: convId, proposal_version: proposal.version, channel: proposal.channel,
      contact_value: value, human_confirmed: true, demo_simulated_consent: true,
    }, true);
    log(`${sim.name}: fixture SUBMITTED ${proposal.channel} contact (simulated_fixture); released=${res.released === true}`);
  }
}

async function handleRelease(sim: SimClient, convId: string, version: number, log: (s: string) => void): Promise<void> {
  if (sim.state.completed_releases.includes(convId)) return;
  try {
    const res = await sim.call('mupit_get_connection_contact', { conversation_id: convId, proposal_version: version });
    sim.state.completed_releases.push(convId);
    log(`${sim.name}: RELEASE complete for ${convId} (channel=${res.channel}; counterpart contact recorded privately)`);
  } catch (err) {
    if (err instanceof SimToolError) log(`${sim.name}: release read failed: ${err.code}`);
    else throw err;
  }
}

/** One bounded tick for one agent. Never loops; ends when waiting. */
export async function runAgentTick(name: string, opts: TickOpts): Promise<void> {
  const fixture = loadFixture(name);
  const sim = opts.connect ? await opts.connect(name) : await SimClient.connect(name, opts.url);
  const log = (s: string): void => opts.log(`[tick:${name}] ${s}`);
  let llmCalls = 0;
  try {
    const capabilities = await sim.call('mupit_start', {});
    const automaticMediation = capabilities.automatic_mediation === true;
    // 1. Poll inbox (non-destructive).
    const poll = await sim.call('mupit_poll', { cursor: sim.state.event_cursor, limit: 20 });
    sim.state.event_cursor = String(poll.next_cursor ?? sim.state.event_cursor);
    const events = (poll.events as Array<{ type: string; payload: Record<string, unknown> }>) ?? [];
    const releases: Array<{ conversation_id: string; version: number }> = [];
    for (const e of events) {
      if (e.type === 'connection.released') {
        releases.push({ conversation_id: String(e.payload.conversation_id), version: Number(e.payload.version) });
      }
    }

    // 2. Current threads (recoverable even if the cursor was lost).
    const list = await sim.call('mupit_list_conversations', { status: 'active', limit: 20 });
    const convs = (list.conversations as Array<{ conversation_id: string; counterpart_id: string; revision: number; facilitation_available: boolean }>) ?? [];
    let processed = 0;
    for (const c of convs) {
      if (processed >= opts.maxThreadsPerTick) break;
      processed += 1;
      const t = threadOf(sim.state, c.conversation_id, c.counterpart_id);
      const read = await sim.call('mupit_read_conversation', { conversation_id: c.conversation_id, after_seq: 0, limit: 100 });
      const messages = ((read.messages as unknown[]) ?? []).map(asMsg);
      const parts = read.participants as Array<{ participant_id: string; introduction: Record<string, unknown> }>;
      const counterpartIntro = parts.find((p) => p.participant_id === c.counterpart_id)?.introduction ?? {};

      await handleProposals(sim, fixture, c.conversation_id, read, log);
      const proposal = read.connection_proposal as null | { status: string; version: number };
      if (proposal?.status === 'released') {
        await handleRelease(sim, c.conversation_id, proposal.version, log);
        continue;
      }

      // Publish one approved, useful introduction even for threads opened before
      // background mode was enabled. Restart-safe bookkeeping avoids duplicates.
      if (opts.background && fixture.background_introduction && !t.background_intro_sent) {
        await sim.call('mupit_send_message', {
          conversation_id: c.conversation_id, kind: 'answer',
          body: backgroundIntroduction(fixture),
        }, true);
        t.background_intro_sent = true;
        sim.persist();
        log('shared approved background introduction and channel preferences');
        await facilitateBackground(sim, c.conversation_id, log, automaticMediation);
        continue;
      }

      const last = messages[messages.length - 1];
      const lastSeen = t.last_seen_seq;
      const maxSeq = last?.seq ?? 0;
      const addressedToMe = !!last && last.seq > lastSeen && (
        (last.sender_role === 'personal_agent' && last.sender_participant_id !== sim.state.participant_id) ||
        (last.sender_role === 'mupit' && last.addressed_participant_ids.includes(sim.state.participant_id))
      );
      if (!addressedToMe) t.last_seen_seq = Math.max(t.last_seen_seq, maxSeq);

      if (addressedToMe && last && t.responses_sent < opts.maxResponsesPerThread) {
        const fact = followupAnswer(fixture, last.body);
        let kind = 'answer';
        let body = '';
        if (opts.live && opts.llm) {
          if (llmCalls >= opts.maxLlmCallsPerTick) {
            log('LLM budget exhausted for this tick; deferring reply');
          } else {
            llmCalls += 1;
            sim.state.llm_calls += 1;
            const thread: ThreadView = {
              conversation_id: c.conversation_id, counterpart_id: c.counterpart_id,
              counterpart_intro: counterpartIntro,
              messages: messages.map((m) => ({ sender_role: m.sender_role, kind: m.kind, body: m.body, seq: m.seq })),
            };
            try {
              const plan = await generateLiveReply(opts.llm, fixture, thread, fact);
              kind = plan.kind;
              body = plan.body;
              if (plan.via_fixture_fact) log(`reply phrased from fixture fact (${plan.via_fixture_fact})`);
              if (plan.needs_human && !fact) log('holding for simulated human (no fixture answer; unknown stays unknown)');
            } catch (err) {
              log(`LLM reply failed (${err instanceof Error ? err.message : String(err)}); deferring`);
              continue;
            }
          }
        } else {
          const plan = generateScriptedReply(fixture, t.script_index);
          if (!plan) {
            log('script exhausted; holding (no invented replies)');
          } else {
            t.script_index += 1;
            kind = plan.kind;
            body = plan.body;
          }
        }
        if (body) {
          const sent = await sim.call('mupit_send_message', { conversation_id: c.conversation_id, kind, body }, true);
          t.last_seen_seq = Math.max(t.last_seen_seq, maxSeq);
          t.responses_sent += 1;
          log(`replied (${kind}) seq=${(sent as { seq: number }).seq}`);
          // At most one facilitator turn per thread per check, when it can advance.
          const fresh = await sim.call('mupit_read_conversation', { conversation_id: c.conversation_id, after_seq: maxSeq, limit: 5 });
          const rev = (fresh as { revision: number }).revision;
          if (!automaticMediation && (fresh as { facilitation_available: boolean }).facilitation_available && !t.facilitated_revs.includes(rev)) {
            try {
              const f = await sim.call('mupit_facilitate', { conversation_id: c.conversation_id, expected_revision: rev }, true);
              t.facilitated_revs.push(rev);
              log(`facilitate rev=${rev} -> ${String(f.status)}`);
            } catch (err) {
              if (err instanceof SimToolError) log(`facilitate failed: ${err.code}`);
              else throw err;
            }
          }
        }
      }

      // 3. Assessment heuristic (opinion only; never consent).
      const exchanges = t.responses_sent;
      if (!t.assessment && exchanges >= 2 && (read as { status: string }).status === 'active') {
        const negative = fixture.name === 'jules';
        const assessment = negative ? 'not_a_fit' : 'promising';
        const rationale = negative
          ? 'Honest mismatch surfaced in conversation: Jules wants fast commitment and deep togetherness; counterpart signals a slow independent pace.'
          : `Two substantive exchanges with aligned values and no surfaced conflicts (assessed after ${exchanges} replies).`;
        try {
          await sim.call('mupit_set_assessment', { conversation_id: c.conversation_id, assessment, rationale }, true);
          t.assessment = assessment;
          log(`assessment -> ${assessment}`);
        } catch (err) {
          if (err instanceof SimToolError) log(`assessment failed: ${err.code}`);
          else throw err;
        }
      }
    }

    for (const r of releases) await handleRelease(sim, r.conversation_id, r.version, log);

    // 4. Optional discovery: real participants only, never seed-to-seed.
    if (opts.discover && (!opts.background || fixture.background_introduction)) {
      const activeCount = convs.length;
      if (activeCount < (opts.background ? opts.maxThreadsPerTick : 2)) {
        const disc = await sim.call('mupit_discover', { limit: 10 });
        const cands = (disc.candidates as Array<{ participant_id: string; is_simulated: boolean }>) ?? [];
        const target = cands.find((cand) => !cand.is_simulated);
        if (target) {
          const opener = opts.background ? backgroundIntroduction(fixture) : opts.live
            ? `Hello from ${fixture.name}'s agent! Your introduction caught our eye — would love to explore whether our values line up. What does a good week look like for your person?`
            : `[MOCK-SCRIPTED opener for ${fixture.name}] Hello! Your introduction looks promising. What does a good week look like for your person?`;
          const opened = await sim.call('mupit_open_conversation', { target_participant_id: target.participant_id, kind: opts.background ? 'answer' : 'question', body: opener }, true);
          if (opts.background) {
            threadOf(sim.state, String(opened.conversation_id), target.participant_id).background_intro_sent = true;
            sim.persist();
            await facilitateBackground(sim, String(opened.conversation_id), log, automaticMediation);
          }
          log(`opened thread with real participant ${target.participant_id}`);
        } else {
          log('discover: no real (non-simulated) candidates; seed-to-seed initiation disabled');
        }
      }
    }

    sim.persist();
  } finally {
    await sim.close();
  }
}

export async function runAllTicks(names: string[], opts: TickOpts): Promise<void> {
  for (const name of names) {
    try {
      await runAgentTick(name, opts);
    } catch (err) {
      opts.log(`[tick:${name}] FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
