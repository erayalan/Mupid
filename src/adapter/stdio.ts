import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logError, logEvent } from '../security/redaction.js';

/**
 * Local stdio-to-HTTP adapter for MCP hosts that only speak stdio.
 * Forwards tool calls to the SAME backend/database over Streamable HTTP —
 * it never starts its own matchmaking logic or database.
 *
 * Env:
 *   MUPIT_URL        backend endpoint (default http://127.0.0.1:3000/mcp)
 *   MUPIT_TOKEN_FILE participant-specific secret file holding the participant
 *                    token (0600). When set, the adapter injects participant_token
 *                    automatically so the agent never pastes it. Identities stay
 *                    isolated: one adapter config (one token file) per human.
 */
async function main(): Promise<void> {
  const url = process.env.MUPIT_URL ?? 'http://127.0.0.1:3000/mcp';
  const tokenFile = process.env.MUPIT_TOKEN_FILE;
  let injectedToken: string | null = null;
  if (tokenFile) {
    injectedToken = readFileSync(tokenFile, 'utf8').trim();
    if (!injectedToken) throw new Error(`MUPIT_TOKEN_FILE ${tokenFile} is empty.`);
  }

  const backend = new Client({ name: 'mupit-stdio-adapter', version: '0.1.0' });
  await backend.connect(new StreamableHTTPClientTransport(new URL(url)));
  logEvent('adapter.connected', { url, token_injected: injectedToken !== null });

  const proxy = new Server({ name: 'mupit', version: '0.1.0' }, { capabilities: { tools: {} } });
  proxy.setRequestHandler(ListToolsRequestSchema, async () => backend.listTools());
  proxy.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = { ...((req.params.arguments ?? {}) as Record<string, unknown>) };
    if (injectedToken && req.params.name !== 'mupit_start' && req.params.name !== 'mupit_register' && args.participant_token === undefined) {
      args.participant_token = injectedToken;
    }
    return backend.callTool({ name: req.params.name, arguments: args });
  });

  await proxy.connect(new StdioServerTransport());
  logEvent('adapter.serving_stdio', {});
}

main().catch((err) => {
  logError('adapter.failed', err, {});
  process.exit(1);
});
