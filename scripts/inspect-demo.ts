import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

/**
 * `npm run inspect:demo` — sanitized local activity inspector for video prep.
 * Reads the demo database directly (developer instrumentation, NOT a
 * Mupit-to-user surface). NEVER prints tokens, registration keys, sealed
 * contact values, or decrypted contacts: those columns are not selected.
 *
 * Flags: --db PATH (default demo/state/demo.db) --conversation ID --json --full
 */
interface Args { db: string; conversation: string | null; json: boolean; full: boolean; }

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = a.indexOf(flag);
    return i >= 0 ? (a[i + 1] ?? null) : null;
  };
  return {
    db: get('--db') ?? process.env.MUPIT_DEMO_DB_PATH ?? 'demo/state/demo.db',
    conversation: get('--conversation'),
    json: a.includes('--json'),
    full: a.includes('--full'),
  };
}

const trunc = (s: string, full: boolean, n = 500): string => (full || s.length <= n ? s : s.slice(0, n) + '…');

function main(): void {
  const args = parseArgs();
  if (!existsSync(args.db)) {
    console.error(`No database at ${args.db}. Run demo:up / seed:demo first.`);
    process.exit(1);
  }
  const db = new DatabaseSync(args.db, { readOnly: true });
  const participants = db.prepare(
    'SELECT id, intro_json, prefs_json, version, is_active, is_simulated, created_at FROM participants ORDER BY id',
  ).all() as Array<Record<string, string | number>>;
  let convs = db.prepare(
    'SELECT id, a_id, b_id, status, revision, facil_last_input_rev, updated_at FROM conversations ORDER BY updated_at DESC',
  ).all() as unknown as Array<{ id: string; a_id: string; b_id: string; status: string; revision: number; facil_last_input_rev: number; updated_at: string }>;
  if (args.conversation) convs = convs.filter((c) => c.id === args.conversation);

  const out: Record<string, unknown> = {
    database: args.db,
    inspected_at: new Date().toISOString(),
    note: 'SANITIZED: no tokens, keys, or contact values are ever printed by this inspector.',
    participants: participants.map((p) => ({
      id: p.id, version: p.version, active: p.is_active === 1, simulated: p.is_simulated === 1,
      introduction: JSON.parse(p.intro_json as string), preferences: JSON.parse(p.prefs_json as string),
    })),
    conversations: convs.map((c) => {
      const messages = db.prepare(
        'SELECT seq, sender_role, sender_participant_id, addressed_ids_json, kind, body, created_at FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
      ).all(c.id) as unknown as Array<{ seq: number; sender_role: string; sender_participant_id: string | null; addressed_ids_json: string; kind: string; body: string; created_at: string }>;
      const assessments = db.prepare('SELECT participant_id, assessment, rationale FROM assessments WHERE conversation_id = ?').all(c.id);
      const proposal = db.prepare('SELECT version, channel, proposer_id, approvals_json, status FROM connection_proposals WHERE conversation_id = ?').get(c.id) as
        | { version: number; channel: string; proposer_id: string; approvals_json: string; status: string } | undefined;
      const subs = proposal
        ? (db.prepare('SELECT participant_id, channel, consent_at, provenance FROM contact_submissions WHERE conversation_id = ? AND proposal_version = ?').all(c.id, proposal.version) as Array<Record<string, unknown>>)
        : [];
      const runs = db.prepare(
        'SELECT input_rev, status, prompt_version, model_id, action, message_id, latency_ms, usage_json, created_at FROM facilitator_runs WHERE conversation_id = ? ORDER BY input_rev ASC',
      ).all(c.id);
      return {
        id: c.id, pair: [c.a_id, c.b_id], status: c.status, revision: c.revision, facil_last_input_rev: c.facil_last_input_rev,
        messages: messages.map((m) => ({
          seq: m.seq, from: m.sender_role, by: m.sender_participant_id, to: JSON.parse((m.addressed_ids_json ?? '[]') as string),
          kind: m.kind, body: trunc(String(m.body), args.full),
        })),
        assessments,
        proposal: proposal ? { ...proposal, approvals: JSON.parse(proposal.approvals_json), contact_submissions: subs } : null,
        facilitator_runs: runs,
      };
    }),
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`Mupit demo inspection: ${args.db} (${out.conversations ? '' : ''}${(out.conversations as unknown[]).length} threads)`);
  for (const p of out.participants as Array<{ id: string; simulated: boolean; introduction: { age: number; region: string; relationship_intent: string } }>) {
    console.log(`- ${p.id}${p.simulated ? ' [SIMULATED]' : ''} age=${p.introduction.age} region=${p.introduction.region} intent=${p.introduction.relationship_intent}`);
  }
  for (const c of out.conversations as Array<{
    id: string; pair: string[]; status: string; revision: number;
    messages: Array<{ seq: number; from: string; kind: string; body: string }>;
    proposal: { version: number; channel: string; status: string } | null;
    facilitator_runs: Array<{ input_rev: number; status: string; model_id: string; action: string | null; latency_ms: number | null }>;
  }>) {
    console.log(`\n# ${c.id} [${c.pair.join(' <-> ')}] status=${c.status} rev=${c.revision}`);
    for (const m of c.messages) console.log(`  ${m.seq}. [${m.from}/${m.kind}] ${trunc(m.body.replace(/\n/g, ' '), args.full, 220)}`);
    if (c.proposal) console.log(`  proposal: v${c.proposal.version} ${c.proposal.channel} ${c.proposal.status}`);
    for (const r of c.facilitator_runs) console.log(`  facil rev=${r.input_rev} ${r.status} model=${r.model_id} action=${r.action} latency=${r.latency_ms}ms`);
  }
}

main();
