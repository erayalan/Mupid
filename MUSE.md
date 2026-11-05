# MUSE.md

Built with Muse Code powered by Meta Muse Spark.

## What this is

Mupit — a headless, agent-to-agent matchmaking service for adults (18+). One local MCP service + one SQLite database. No website, no app UI, no photos, no login system. It talks ONLY to personal agents, never to users.

Flow: personal agent interviews its human → publishes approved pseudonymous intro → discovers matches → discusses compatibility in three-way threads facilitated by Mupit → brings promising intros back to its human.

## Stack

- Node >= 24, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM (`NodeNext`)
- MCP: `@modelcontextprotocol/sdk` Streamable HTTP on loopback (`/mcp`, default `127.0.0.1:3000`)
- Storage: SQLite (WAL) + AES-256-GCM contact vault (key in env/file, never in DB/prompts)
- Inference: Meta Model API (`https://api.meta.ai/v1`, default `muse-spark-1.3`) for facilitator + live sim replies
- Runner/tests: `tsx`, `vitest` (40 tests across 14 files, no credentials needed)

## Commands

```bash
npm install
npm run setup:local   # generate local secrets, never overwrites
npm run typecheck
npm test              # vitest run
npm run dev           # server on :3000, data/mupit.db; health GET /healthz
npm run build         # tsc -> dist/
npm run demo          # deterministic mock demo over real MCP+SQLite
npm run demo:live     # real Meta facilitator smoke test (needs META_API_KEY)
npm run demo:up       # demo server :3001 + seed + sims (Ctrl-C stops)
npm run demo:tick     # one bounded sim cycle (--live for real model replies)
npm run inspect:demo  # sanitized transcript, never prints tokens/contacts
npm run seed:demo     # idempotent fictional seeding; --reset deletes ONLY demo DB+state
```

## Layout

- `src/server.ts` — HTTP entry, loopback-only guard
- `src/mcp/tools.ts` — 19 tools, auth, idempotency
- `src/domain/` — profiles, discovery, conversations, connections, events, schemas
- `src/facilitator/` — scoped mediator (1 turn/call, lease, validated JSON), auto-queued on every agent message
- `src/security/` — tokens (HMAC, store hashes only), vault, redaction
- `src/db/` — SQLite store
- `src/adapter/stdio.ts` — token-injecting stdio adapter for local Muse
- `scripts/` — setup, seed, demo harnesses, tunnel, inspect
- `tests/` — per-area invariant tests + `helpers.ts`
- `docs/` — `agent-playbook.md`, `architecture.md`, `reviewer-guide.md`, `demo-script.md`, `tunnel-demo.md`, `background-demo.md`

## Rules for working here

- Server binds loopback only (`MUPIT_HOST`/`PORT`/`DB_PATH` configurable). Never expose publicly.
- Identity ALWAYS comes from `participant_token`; transport sessions are stateless.
- Facilitator output is advisory JSON only — cannot approve, release, invoke tools, or override filters. Model context is an explicit allowlist; tokens, keys, contact values, and unrelated pairs never enter prompts.
- Server NEVER silently falls back to mock when live credentials fail (`MUPIT_FACILITATOR_MODE=live|mock`).
- Demo mode (`MUPIT_DEMO_MODE=1`) is required for seed/demo scripts and must stay off for any real-user DB. Sim clients use public MCP tools only, no DB imports.
- Never commit secrets: `.env`, `data/`, `*.db*`, `.server-secret`, `.vault-key`, `demo/state/` are gitignored. Copy `.env.example` → `.env`, set `META_API_KEY`.
- Never print tokens/contacts in logs or transcripts; use `npm run inspect:demo` for sanitized output.
- Before finishing: `npm run typecheck && npm test`.

## Docs first

Read `README.md`, then `docs/architecture.md` (trust boundaries, state machines) and `docs/agent-playbook.md` (join/check/connect workflows) before changing domain or MCP behavior.
