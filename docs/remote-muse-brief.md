# Coding-agent brief: demo Mupit from the remote Muse chat

## Objective

The human wants their existing remote Muse chat to act as their personal agent.
They do not want to conduct the demo in a new local Muse CLI session. Keep the
real Mupit implementation on their Mac and establish a private route from the
remote Muse environment to it. Do not create a replacement matchmaking service.

## Latest live-inference update, October 29, 2026

Billing is fixed. Live `muse-spark-1.3` facilitator output has been committed
through actual MCP calls on the existing demo threads, and the background worker
has posted a real model-generated agent reply. The initial completion limit
exhausted its 1,200 tokens in reasoning; facilitator and live-agent limits are
now 8,192 tokens. The server was restarted in `--live --background` mode with
the existing database and tunnel retained. Re-read `mupit_start` for its appended
background-demo workflow. Earlier billing failures below are historical, not a
current blocker. Never invent human answers to questions the model raises.

## Verified state, October 29, 2026

- Repository on Mac: `/Users/erayalan/Documents/Mupid`.
- Real MCP endpoint: `http://127.0.0.1:3001/mcp`.
- Health endpoint: `http://127.0.0.1:3001/healthz`.
- An actual SDK call to `mupit_start` returned `server_version: "0.1.0"` and
  `facilitator_mode: "live"`.
- `npm run demo:up -- --live` runs the server, seeds five fictional adults, and
  polls their separate simulated personal agents every four seconds.
- Type checking, compilation, and 29 tests pass, including real HTTP requests
  from concurrent MCP clients. Stateless transports are created per request.
- Meta inference was attempted and returned HTTP 402, `billing_not_configured`.
  Resolve billing at https://dev.meta.ai/billing/ for live model replies. A
  configured key and a healthy server do not establish inference readiness.
- Tailscale was not found on PATH or in the checked common app/binary locations
  on the Mac. Its installation, login, and network membership are unverified.
- The remote chat's Tailscale device approval and network state have not been
  inspected from this Mac. Verify them in that environment; do not assume that
  a previous assistant's claim establishes connectivity.

## Architecture and identity

Remote Muse is one MCP client. Mupit owns SQLite state, discovery, pair threads,
connection proposals, and encrypted contact submissions. The fictional agents
are other MCP clients, running on the Mac through `demo/agents/runner.ts`.
Mupit's facilitator makes separate Meta API requests using a server-side key.

Only `mupit_start` and registration are public entry points. Subsequent private
operations require a secret `participant_token`. Mutations require request IDs;
registration instead has its own secret idempotency key. Local-only networking
does not mean private tools have no authentication. Never share the Meta API
key, vault key, server secret, or another participant's token with remote Muse.

## Establish connectivity before conducting the demo

`127.0.0.1` in the remote chat refers to its VM, not the Mac. A working local
Muse CLI test does not configure the existing remote chat's tool registry.

Mupit deliberately binds to loopback. It also accepts only loopback Host headers
and loopback Origins, as defined in `src/server.ts`. Merely installing Tailscale
and requesting `http://<mac-tailscale-ip>:3001/mcp` will not work.

One route that preserves the existing server rules is an SSH local forward
created INSIDE THE REMOTE ENVIRONMENT:

```bash
ssh -N -L 127.0.0.1:3001:127.0.0.1:3001 <mac-user>@<reachable-private-mac-host>
```

This requires an actual private route to the Mac, an SSH server on the Mac, and
authorized SSH credentials. Those are prerequisites, not verified capabilities.
Use another remote local port if 3001 is occupied. Requests to the forwarded
loopback port preserve the Host header Mupit accepts when using port 3001.
Keep the tunnel alive for the demo.

Alternatively, use Tailscale Serve for private HTTPS access, with a deliberately
configured bridge that forwards to `127.0.0.1:3001` and rewrites the upstream Host
to `127.0.0.1:3001`. Handle Origin validation explicitly rather than disabling
it globally. A direct Serve proxy can preserve the external Host and therefore
hit Mupit's existing rejection. Do not change the server to listen on all network
interfaces or accept arbitrary Hosts as a shortcut.

Tailscale Serve limits access to the tailnet; use tailnet access rules to limit
the demo route to the intended remote device. Do not enable public Funnel for
this demo. Sources:

- https://tailscale.com/docs/reference/tailscale-cli/serve
- https://tailscale.com/docs/features/tailscale-serve
- Host forwarding implementation:
  https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go

After routing, request `/healthz` FROM THE REMOTE ENVIRONMENT. Then connect with
the official MCP SDK and call `tools/list` and `mupit_start`. Report the actual
results. A check from the Mac alone does not validate the remote route.

## Give the remote chat access to MCP

If the remote host supports registering a custom MCP server, configure the
verified reachable endpoint using that host's documented settings. Do not assume
the Muse CLI `-c` option modifies an already-open remote chat.

If the remote chat can run code and make network requests but cannot add native
tools, it can use a small MCP SDK client in its VM. That is the real service,
accessed through a client, not a simulated stand-in. Do not claim that
`mupit_start` appeared as a native chat tool in this case. If neither integration
method is available, state the missing host capability clearly.

Let the SDK perform initialization, initialized notification, schema discovery,
and calls. This server is stateless and does not issue an MCP transport session
ID. Its participant identity comes from tokens, not an `mcp-session-id` header.
Check both transport failures and tool-level `isError`/`ok` results.

## Conduct the demo through the remote conversation

1. Call `mupit_start` and report its actual version and mode. Read its playbook.
2. Treat "I want to find love with Mupid" as the entry point. Ask the human to describe themselves and whom they seek; follow up only on missing essentials. Have the human choose real answers or the fictional persona from
   `demo/fixtures/suggested-user.json`. The remote VM cannot read the Mac's path
   automatically; provide the nonsecret fixture separately if needed.
3. Show the exact pseudonymous introduction and structured preferences. Obtain
   adult self-attestation and approval of that exact publication before calling
   `mupit_register`. Save the returned secret token in the remote agent's private
   storage with mode 0600; never print it in a shared transcript.
4. After registration, begin one bounded discovery/conversation check before inviting the human to check back. On "Is there anyone out there for me?", resume from actual replies and offer evidence-grounded suggestions in ordinary language. See `docs/natural-demo.md`. Use `mupit_poll` for events, `mupit_discover` for candidates, and
   `mupit_read_conversation` for thread content. There is no generic match-list
   call that replaces these distinct operations.
5. Select candidates from actual evidence, never a scripted outcome. If Sam is relevant, identify the Seattle bookworm/tabletop-gamer introduction; fixture
   labels are not necessarily public names. Open a thread asking about pace,
   distance, and time together. Use approved facts only. Ask the human when
   additional personal facts are needed.
6. Facilitate only when available, using a fresh conversation revision. A check
   is bounded: at most about five threads, two new threads, one substantive
   reply and one facilitation per thread. Stop when waiting. Background simulator
   polling does not imply that the human's remote Muse runs on a schedule.
7. Surface facilitator questions and distinguish its messages from the personal
   agents' messages. Do not invent replies or force positive recommendations.
8. After human approval, propose Instagram to Sam. Sam's fixture counters with
   email. Obtain separate human approval of the current email proposal version;
   a counter invalidates previous approvals and submissions.
9. Obtain the exact contact value and explicit permission to release it to Sam
   under the mutual-submission rule. Submit through `mupit_submit_contact`, never
   in normal conversation text. Read through `mupit_get_connection_contact` only
   after mutual release. Send no email, DM, or SMS.

Publication, new channel approvals, and contact release require explicit human
decisions. Ordinary checks and messages based on already-approved facts follow
the user's authorized task and the playbook; the implementation does not demand
a new confirmation for every tool call.

## Readiness and honest reporting

The remote demo is ready only when the remote environment successfully invokes
the real tools and the fictional agents can respond. Live mode additionally
requires a successful Meta inference call. If the human chooses mock mode,
restart the demo explicitly with
`MUPIT_FACILITATOR_MODE=mock npm run demo:up` and label the facilitator and
fictional-agent replies as simulated. Do not silently switch modes.

Do not overwrite `.env` or reset the demo database during connection setup.
Keep tokens, API keys, and contact values out of logs and transferred bundles.
The existing `docs/local-demo.md` contains suggested human prompts and
`docs/agent-playbook.md` contains the full protocol workflow.
