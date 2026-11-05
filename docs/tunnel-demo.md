# Use Mupit from a remote Muse chat

The tunnel was started with explicit user approval on October 29, 2026. Public
MCP discovery returned 19 tools, and `mupit_start` returned version `0.1.0` in
`live` mode. See `demo/state/tunnel.json` for the most recently verified endpoint.

## Start

Keep the existing local demo server running on port 3001. For future runs:

```bash
npm run demo:up -- --live
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
loopback-only. The current demo's hostname has been configured. Keep it in sync
if the tunnel hostname changes. The tunnel launcher still requests Host rewriting
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

Billing was fixed on October 29, 2026. Actual live `muse-spark-1.3`
facilitator output has since been committed through MCP, and live fictional-agent
replies have been observed. The completion budget was raised to 8,192 tokens to
allow for internal reasoning before the JSON reply. Earlier HTTP 402 failures
are historical. A future startup check alone still cannot establish inference
readiness; verify an actual facilitator result when diagnosing the service.

To choose a simulated rehearsal explicitly, stop the live demo server and run:

```bash
MUPIT_FACILITATOR_MODE=mock npm run demo:up
```

Then restart the tunnel if needed and label mock output as simulated.
