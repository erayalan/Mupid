# Reviewer guide

Setup, MCP connection options, and verification steps for the Mupid prototype. See the limitations below for deployment and consent boundaries.

## 1. Setup

```bash
npm install
npm run setup:local        # generates data/.server-secret + data/.vault-key (0600, never overwritten)
npm run typecheck && npm test
npm run build
```

Offline protocol demo (mock facilitator, scripted lines — explicitly labeled, no credentials needed):

```bash
npm run demo               # spins a mock-mode server, runs the full story over MCP, asserts each step
```

Live Meta demo (requires a key from the Meta developer platform):

```bash
# Create .env from .env.example only if absent, then set META_API_KEY.
node --env-file=.env --import tsx scripts/demo-live.ts
# Real muse-spark-1.3 facilitator turns with fictional data.
```

Demo instance with simulated agents:

```bash
npm run demo:up -- --live      # server :3001 + seed + sim polling (Ctrl-C stops)
npm run demo:tick              # one bounded sim cycle (deterministic recording)
npm run demo:tick -- --live    # same with real model-generated sim replies
npm run inspect:demo           # sanitized transcript for video prep
```

Health/readiness: `GET http://127.0.0.1:3000/healthz` (or :3001 for demo) returns `{ok, server, version, ...}` after a DB probe. Clean shutdown: SIGINT/SIGTERM (Ctrl-C) closes HTTP, MCP, and SQLite.

## 2. Verified Muse configuration

Muse Code supports MCP servers in `~/.config/muse/settings.json` under `mcp_servers` (verified: official docs + CLI behavior), with `stdio` and `streamable_http` transports. For a client running on the same machine as the backend, use loopback HTTP directly. For remote Muse, follow [the HTTPS tunnel setup](tunnel-demo.md).

Option A — direct HTTP (recommended for the demo):

```json
{
  "schema_version": 1,
  "mcp_servers": {
    "mupit-demo": { "transport": "streamable_http", "url": "http://127.0.0.1:3001/mcp", "mode": "optional" }
  }
}
```

The agent passes `participant_token` explicitly per call (it persists the token in its private workspace after registration). Verify inside a session with `/mcp`, then: "Call mupit_start and tell me the server version."

Option B — stdio adapter with token injection (agent never pastes the token):

```bash
npm run build
echo -n '<participant_token>' > /path/private/mupit-token  # chmod 600
```

```json
{
  "schema_version": 1,
  "mcp_servers": {
    "mupit-demo": {
      "transport": "stdio",
      "command": "node",
      "args": ["<repo>/dist/src/adapter/stdio.js"],
      "env": {
        "MUPIT_URL": "http://127.0.0.1:3001/mcp",
        "MUPIT_TOKEN_FILE": "/path/private/mupit-token"
      },
      "mode": "optional"
    }
  }
}
```

The adapter forwards to the same backend/database and injects the token from the 0600 file. One adapter config (one token file) per human — identities stay isolated.

Headless one-shot check (no settings change; `-c` values are JSON):

```bash
muse exec -c 'mcpServers.mupit-demo={"transport":"streamable_http","url":"http://127.0.0.1:3001/mcp"}' \
  "Call ONLY the mupit_start tool and report server_version and facilitator_mode."
```

The demo walkthrough covers registration, discovery, clarification, channel approval, and mutual contact exchange. To reproduce it, establish your own MCP connection using the options above or [the remote setup](tunnel-demo.md). A saved tunnel URL does not establish current availability.

## 3. Live API prerequisites

- `META_API_KEY` (or `MODEL_API_KEY` fallback) from the Meta developer platform.
- Defaults already point at the verified endpoint: `META_BASE_URL=https://api.meta.ai/v1`, `META_MODEL=muse-spark-1.3` (verified 2026-10-28 in official docs: OpenAI-compatible Chat Completions + `response_format` JSON schema).
- Missing credentials in live mode produce a clear `SETUP_ERROR`, never silent mock output. Mock mode requires explicit `MUPIT_FACILITATOR_MODE=mock` and labels every output `mock`.

## 4. Offline evaluation path (no credentials, no Muse)

```bash
npm test            # 40 tests across 14 files; MCP transports + SQLite + HTTP sockets
npm run demo        # deterministic end-to-end protocol story over real HTTP + mock facilitator
```

These exercise the backend, auth, state machine, and simulator mechanics. They do NOT establish current Muse connectivity or model quality — those need sections 2 and 3. Socket tests return early when the environment forbids listening; the November 4, 2026 verification also ran outside that restriction, with all 40 tests passing and no socket checks skipped.

## 5. Pointers to important code and tests

| Concern | Code | Tests |
|---|---|---|
| Auth, registration retry | `src/domain/profiles.ts`, `src/security/tokens.ts` | `tests/registration.test.ts`, `tests/auth.test.ts` |
| Reciprocal filters | `src/domain/discovery.ts` | `tests/discovery.test.ts` |
| Threads, events, idempotency | `src/domain/conversations.ts`, `events.ts`, `idempotency.ts` | `tests/conversations.test.ts` |
| Negotiation + atomic release | `src/domain/connections.ts` | `tests/connections.test.ts` |
| Scoped facilitator | `src/facilitator/*` | `tests/facilitator.test.ts` |
| Vault + key failure | `src/security/contact-vault.ts` | `tests/vault.test.ts` |
| Screening + injection | `src/domain/identifiers.ts` | `tests/identifiers.test.ts` |
| MCP contract (19 tools) | `src/mcp/tools.ts` | `tests/mcp-contract.test.ts` |
| Simulator + fixtures | `demo/agents/*`, `demo/fixtures/*` | `tests/simulator.test.ts` |

## 6. Actual limitations

- Age and human approval are self-attested / agent-reported, not verifiable. Provenance labels (`human_reported_by_personal_agent`, `simulated_fixture`) say exactly this.
- Identifier screening is best-effort regex; prose can conceal contact info. Agents are instructed to prohibit it regardless.
- Single-process rate limiting (in-memory), no vault-key rotation, no multi-device token recovery (by design: losing the token loses access).
- Facilitator v1 triggers only on new agent input (assessment/proposal-only changes surface via events; agents discuss them, which re-enables inference).
- Server-owned automatic mediation and the demo-agent polling loop are implemented. Scheduling or notifications in the Muse host are not implemented by this service. The Muse walkthrough demonstrates the end-to-end user flow; automated tests evaluate the backend separately.
