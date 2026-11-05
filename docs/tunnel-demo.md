# Use Mupit from a remote Muse chat

Use the demo tunnel to connect a remote Muse session to the MCP backend. The launcher verifies tool discovery and `mupit_start` before printing the HTTPS endpoint. Connection metadata is saved to the gitignored `demo/state/tunnel.json`; a fresh checkout creates it when the launcher runs.

## Start

Start the demo server on port 3001:

```bash
npm run demo:up -- --live --background
```

In a second terminal:

```bash
npm run demo:tunnel
```

The installed ngrok CLI and its existing account configuration are used. The
launcher checks that the backend reports demo mode, rewrites the upstream Host
to `127.0.0.1:3001`, and disables ngrok request inspection so request bodies are
not retained in the local inspection dashboard. The Mupit server stays bound to
loopback. The tunnel still relays MCP traffic through ngrok; no additional
tunnel password is configured. Private Mupit operations retain their existing
per-participant token authentication; onboarding and registration are public.

The launcher waits for public health, lists MCP tools, and calls `mupit_start`
over the HTTPS endpoint before printing the verified URL, tool count, version,
and mode. It saves these nonsecret connection details to the gitignored file
`demo/state/tunnel.json`. A saved URL does not prove the tunnel is still running.
Ctrl-C stops the tunnel; stop the demo server separately when finished.

## Exact tunnel host configuration

If ngrok forwards its public Host instead of the requested loopback rewrite,
set `MUPIT_TUNNEL_HOST` to the exact hostname of the verified endpoint in `.env`
and restart `demo:up`. Do not include a scheme, path, port, or wildcard. The
server accepts that one Host and its HTTPS Origin in addition to loopback;
unrelated hosts and origins remain blocked, and the listening address stays
loopback-only. Keep this setting in sync if the tunnel hostname changes. The tunnel launcher still requests Host rewriting
and keeps request inspection disabled.

## Give the URL to remote Muse

Paste this into the remote chat, replacing the placeholder with the launcher’s
verified endpoint:

```text
Use the real Mupit MCP service at <HTTPS-ENDPOINT-ENDING-IN-/mcp>.
Connect with Streamable HTTP. If this chat cannot register native MCP tools,
use an MCP SDK client from your environment to access that endpoint.
Complete initialization, discover tools, and call mupit_start. Report the
actual server_version and facilitator_mode. Do not register anyone yet.
Do not use 127.0.0.1 or the Mac's filesystem paths from your remote environment.
```

A tunnel provides network access. Remote Muse must still have a way to use an
MCP client or run code. If its host provides neither, a reachable URL alone
cannot add tools to that chat.

Once that remote check succeeds, ask Muse to help you join using a fictional
persona. The remote agent will need the persona text, since it cannot read the
Mac's fixture file. Use the prompts in `docs/local-demo.md`, keeping explicit
publication, channel, and contact-release approvals.

## Live inference prerequisite

Live inference requires a valid Meta API key and available credits/billing. The facilitator and live-agent completion budgets allow for internal reasoning before the JSON reply. Check an actual facilitator result to verify inference readiness; a healthy endpoint alone is not sufficient.

To choose a simulated rehearsal explicitly, stop the live demo server and run:

```bash
MUPIT_FACILITATOR_MODE=mock npm run demo:up
```

Then restart the tunnel if needed and label mock output as simulated.
