import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { demoPort, waitForHealth } from './demo-env.js';

/** Publish only the explicit demo instance; keep the backend bound to loopback. */
async function main(): Promise<void> {
  const port = demoPort();
  const upstream = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(`${upstream}/mcp`, 5000);
  if (health.demoMode !== true) throw new Error('Refusing to tunnel a server outside demo mode.');

  const child = spawn('ngrok', [
    'http', upstream,
    `--host-header=127.0.0.1:${port}`,
    // MCP calls can contain private participant tokens and contact submissions.
    '--inspect=false', '--log=stdout', '--log-format=json',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let verifiedUrl: string | null = null;
  let pending = '';
  let verifying = false;
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    child.kill('SIGTERM');
  };
  const startupDeadline = setTimeout(() => {
    console.error('ngrok did not announce an HTTPS endpoint within 45 seconds.');
    process.exitCode = 1;
    stop();
  }, 45_000);
  startupDeadline.unref();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.on('error', (err) => {
    clearTimeout(startupDeadline);
    console.error(`Cannot start ngrok: ${err.message}. Install ngrok and configure its account first.`);
    process.exitCode = 1;
  });
  child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
  child.on('exit', (code) => {
    clearTimeout(startupDeadline);
    if (!stopping) {
      console.error(`ngrok exited (${code ?? 'signal'}).`);
      process.exitCode = code || 1;
    }
    if (verifiedUrl) console.log(`Tunnel stopped: ${verifiedUrl}`);
  });

  const verify = async (baseUrl: string): Promise<void> => {
    const endpoint = `${baseUrl}/mcp`;
    // Wait for the public edge, then test real MCP discovery and onboarding.
    await waitForHealth(endpoint, 30_000);
    const client = new Client({ name: 'mupit-tunnel-check', version: '0.1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
      const tools = await client.listTools();
      const result = await client.callTool({ name: 'mupit_start', arguments: {} });
      const data = result.structuredContent as Record<string, unknown> | undefined;
      if (result.isError || data?.ok !== true) throw new Error('Public mupit_start failed.');
      const info = {
        endpoint, server_version: data.server_version,
        facilitator_mode: data.facilitator_mode, tool_count: tools.tools.length,
        started_at: new Date().toISOString(),
      };
      mkdirSync('demo/state', { recursive: true });
      writeFileSync('demo/state/tunnel.json', JSON.stringify(info, null, 2) + '\n', { mode: 0o600 });
      verifiedUrl = endpoint;
      console.log('\nVerified public MCP endpoint:\n' + JSON.stringify(info, null, 2));
      console.log('\nGive the endpoint to remote Muse. Keep this process and demo:up running. Ctrl-C stops the tunnel.');
    } finally {
      await client.close().catch(() => {});
    }
  };

  child.stdout.on('data', (data: Buffer) => {
    pending += data.toString();
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      let log: Record<string, unknown>;
      try { log = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (log.lvl === 'eror' || log.lvl === 'error' || log.lvl === 'crit') console.error(line);
      if (!verifying && typeof log.url === 'string' && log.url.startsWith('https://')) {
        clearTimeout(startupDeadline);
        verifying = true;
        void verify(log.url).catch((err: unknown) => {
          console.error(`Tunnel verification failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
          stop();
        });
      }
    }
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
