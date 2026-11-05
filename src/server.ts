import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, parseTunnelHost, publicConfigSummary, type MupitConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { Store } from './db/store.js';
import { MediationWorker } from './facilitator/worker.js';
import { ContactVault } from './security/contact-vault.js';
import { logError, logEvent } from './security/redaction.js';
import { WriteRateLimiter, type AppContext } from './mcp/context.js';
import { SERVER_NAME, SERVER_VERSION, createMcpServer } from './mcp/tools.js';

const MAX_BODY_BYTES = 1_000_000;

function allowedHosts(port: number, tunnelHost?: string): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(tunnelHost ? [tunnelHost, `${tunnelHost}:443`] : [])];
}

function allowedOrigins(port: number, tunnelHost?: string): string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(tunnelHost ? [`https://${tunnelHost}`] : [])];
}

export async function startServer(cfg: MupitConfig): Promise<{ close: () => Promise<void>; url: string }> {
  const tunnelHost = parseTunnelHost(cfg.tunnelHost);
  const db = openDatabase(cfg.dbPath);
  const ctx: AppContext = {
    cfg,
    db,
    store: new Store(db),
    vault: new ContactVault(cfg.vaultKey, cfg.vaultKeyId),
    writes: new WriteRateLimiter(cfg.writeRateLimitPerMin),
  };
  // Each stateless request needs its own server/transport; domain state is
  // shared through ctx, and identity always comes from participant_token.
  const activeServers = new Set<ReturnType<typeof createMcpServer>>();
  let actualPort = cfg.port;
  const mediator = cfg.automaticMediation !== false ? new MediationWorker(db, cfg) : undefined;

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const host = (req.headers.host ?? '').toLowerCase();
      if (!allowedHosts(actualPort, tunnelHost).includes(host)) {
        res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Forbidden host.' }));
        return;
      }
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname === '/healthz' && req.method === 'GET') {
        db.prepare('SELECT 1 AS ok').get();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({ ok: true, server: SERVER_NAME, version: SERVER_VERSION, ...publicConfigSummary(cfg) }),
        );
        return;
      }
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found. MCP endpoint is POST /mcp; health is GET /healthz.' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Only POST is supported on /mcp.' }));
        return;
      }
      const mcp = createMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: allowedHosts(actualPort, tunnelHost),
        allowedOrigins: allowedOrigins(actualPort, tunnelHost),
        maxRequestBodySize: MAX_BODY_BYTES,
      });
      transport.onerror = (err) => logError('mcp.transport_error', err, {});
      activeServers.add(mcp);
      res.on('close', () => {
        activeServers.delete(mcp);
        void mcp.close().catch(() => {});
      });
      // Hand the live stream to the SDK transport; it reads/parses the body
      // itself (with its own size limit + JSON errors). Never pre-consume
      // req here: the transport's converter needs the unread stream.
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      logError('http.request_failed', err, { method: req.method, path: req.url });
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : 'Request failed.';
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: msg }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(cfg.port, cfg.host, () => {
      http.off('error', reject);
      http.on('error', (err) => logError('server.socket_error', err, {}));
      resolve();
    });
  });
  const addr = http.address();
  actualPort = typeof addr === 'object' && addr !== null ? addr.port : cfg.port;
  const url = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${actualPort}/mcp`;
  logEvent('server.started', { url, db: cfg.dbPath, ...publicConfigSummary(cfg) });

  mediator?.start();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const mediationStopped = mediator?.stop();
    await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
    await Promise.all([...activeServers].map((mcp) => mcp.close().catch(() => {})));
    await mediationStopped;
    db.close();
    logEvent('server.stopped', {});
  };
  const onSignal = (): void => {
    void close().then(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return { close, url };
}

// Run directly: `npm run dev` / `node dist/server.js`
const invokedDirectly = process.argv[1]?.endsWith('/server.ts') || process.argv[1]?.endsWith('/server.js');
if (invokedDirectly) {
  const cfg = loadConfig();
  startServer(cfg).catch((err) => {
    logError('server.start_failed', err, {});
    process.exit(1);
  });
}
