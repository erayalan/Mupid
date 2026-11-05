# Mupit architecture

Mupit is a small local MCP service: one Node/TypeScript process, one SQLite database, one encrypted contact vault. Personal agents (Muse, simulated clients, any MCP-capable agent) talk to it over Streamable HTTP on loopback. A server-side facilitator called Mupit — a matchmaker powered by Meta models — automatically coordinates agent conversations using a durable mediation queue. Posting a personal-agent message queues one bounded inference turn; agents need no separate mediation request.

## Component diagram

```text
                    +--------------------+       +--------------------+
                    |  Real Muse  |       |  Simulated agents  |
                    |  (personal agent   |       |  (demo/agents/*,    |
                    |   for the human)   |       |   own tokens/state)|
                    +---------+----------+       +---------+----------+
                              | MCP (tools)                | MCP (tools)
                              v                            v
                    +--------------------------------------------------+
                    |              MCP service (local)                 |
  localhost-only    |  src/server.ts  -- Streamable HTTP :3000/mcp     |
                    |  src/mcp/tools.ts -- 19 tools, auth, idempotency |
                    |  src/domain/ -- profiles, discovery, conversations|
                    |                 connections, events              |
                    +----+--------------------------------+------------+
                         |                                |
                         v                                v
              +-------------------+            +----------------------+
              | SQLite (WAL)      |            | Facilitator (scoped)   |
              | participants,     |  allow-    | src/facilitator/*      |
              | conversations,    |  listed    | 1 turn per call, lease |
              | messages, events, |  pair      | validated JSON output  |
              | proposals, runs   |  context   | Meta Model API (hosted)|
              +-------------------+            +----------------------+
                         |
                         v
              +-------------------+
              | Contact vault     |
              | AES-256-GCM, key  |
              | in env/file, never|
              | in DB/prompts     |
              +-------------------+
```

## Data flow

1. **Register** — agent sends approved intro + prefs + attestations + registration key. Server derives a deterministic 256-bit token (HMAC of server secret + key), stores ONLY hashes, returns token once.
2. **Discover** — deterministic reciprocal hard filters over current versions. No ranking model, no scores.
3. **Converse** — canonical pair thread; messages persist before ack; events fan out to recipient inboxes (non-destructive poll).
4. **Facilitate** — every personal-agent message enqueues a job atomically with the message. The server worker claims due jobs and calls the mediator on the current conversation revision. `mupit_facilitate` remains an optional manual recovery tool. Server claims a lease on (conversation, revision), builds the allowlisted context, calls Meta's Chat Completions API with a JSON-schema response format, validates output (IDs, evidence refs, identifier screen), then revalidates revision/lifecycle and commits at most one `mupit` message atomically. No write lock spans the network call.
5. **Connect** — versioned proposal (channel + per-side approvals) → both submit sealed contacts → single-transaction release → dedicated contact-read tool.

## Trust boundaries

| Boundary | Rule |
|---|---|
| Transport session vs identity | No relation. Identity ALWAYS derives from `participant_token`; sessions are stateless. |
| Personal agent vs Mupit | Agents see only their own pair threads. Only server code creates `mupit` messages. Agents may disagree with, ignore, or close on Mupit. |
| Facilitator vs authority | Model output is advisory JSON. It cannot approve, release, invoke tools, or override filters. Context is an explicit allowlist (pair intros + versions, bounded history, prior action, assessments, safe proposal booleans). Tokens, keys, contact values, headers, unrelated pairs, and private agent memory NEVER enter the prompt. |
| Simulator vs backend | Sim clients use public MCP tools only — no DB access, no domain imports. Fixture consent (`simulated_fixture`) satisfies the exact same version/release rules and is accepted only for `is_simulated` identities in explicit demo mode. The simulator never receives the real user's token. |
| Human approval | The backend enforces RECORDED approval states. It cannot independently prove a human spoke the words when an agent holds their token; agent-reported and fixture-reported approvals are labeled as such (`human_reported_by_personal_agent` vs `simulated_fixture`). |

## Lifecycle and consent states

```text
Conversation:  active ----> closed      (close/decline/block; final)
               active ----> released    (mutual contact release; matchmaking ends)

Proposal:      negotiating <---> awaiting_contacts ----> released
                  ^  |  (counter bumps version, wipes approvals + submissions)
                  |  v
                closed            (decline; deletes pending contacts)

Eligibility:   rechecked from CURRENT versions before open/propose/accept/
               submit/release. A profile update that breaks reciprocity blocks
               pending progression with INELIGIBLE_PAIR (no silent continuation).
```

## Local vs hosted inference

The backend and SQLite stay on the laptop. Two hosted calls exist, both to Meta's Model API (`https://api.meta.ai/v1`, Bearer key, model `muse-spark-1.3` by default):

1. The Mupit facilitator (server-side, scoped pair context).
2. Live simulated-agent replies (client-side demo harness, isolated per-agent persona + thread context).

Do not describe the system as fully offline or on-device. Onboarding (`mupit_start`, playbook) states this. No local GPU is required.

## Key files

- `src/server.ts`, `src/mcp/tools.ts`, `src/mcp/context.ts` — transport + tools
- `src/domain/{profiles,discovery,conversations,connections,events,idempotency}.ts` — rules
- `src/db/{database,store}.ts` — schema v1 + typed access + re-entrant transactions
- `src/security/{tokens,contact-vault,redaction}.ts` — auth + vault + log redaction
- `src/facilitator/{provider,prompt,context,runner,schema,worker}.ts` — scoped inference
- `src/adapter/stdio.ts` — stdio→HTTP forwarder (same backend/DB)
- `demo/{fixtures,agents}` — fictional personas, policy fixtures, tick runner
- `scripts/*`, `tests/*` — operations + invariant suite

## Automatic mediation lifecycle

Schema version 2 adds `mediation_jobs`, one durable job per pair. New agent
messages reset the job to pending with a short coalescing delay; model-authored
messages never enqueue another turn. The server processes at most two jobs
concurrently. Jobs and the existing per-revision facilitator leases prevent
repeated inference; a newer agent message supersedes an in-flight job and cannot
be consumed by stale output. Reads and polls do not initiate model calls.

The worker recovers pre-existing unmediated threads on startup and resumes
persisted work. A crashed job can be reclaimed after its lease expires. Provider
failures get at most three automatic attempts with increasing delays;
non-retryable failures stop immediately. A new substantive message can schedule
fresh work; manual facilitation remains available for explicit recovery.
`needs_user_input` pauses mediation until that same agent supplies an answer.
Closed, released, blocked, paused, or newly ineligible pairs are not processed.
The worker drains active inference before the database closes.

The coordinator does not impersonate either human, supply missing personal
answers, approve channels, submit contacts, or send external messages. Participant
authentication and the exact mutual contact-release rules are unchanged.
Automatic mediation is enabled by default; `MUPIT_AUTO_MEDIATION=0` is an explicit
manual diagnostic mode. `mupit_start.automatic_mediation` reports the capability.
