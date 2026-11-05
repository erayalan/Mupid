import { spawn, type ChildProcess } from 'node:child_process';
import { runAllTicks, type TickOpts } from '../demo/agents/runner.js';
import { BACKGROUND_DEMO_AGENTS, DEMO_AGENTS, demoDbPath, demoPort, demoUrl, liveEnv, waitForHealth } from './demo-env.js';
import { seedDemo } from './seed-demo.js';

/**
 * `npm run demo:up` — local demo instance: demo server (own port + own demo
 * database) + seed-if-needed + responsive simulated agents polling in the
 * background. Ctrl-C shuts everything down cleanly.
 *
 * Flags: --live (real Meta-model sim replies; needs META_API_KEY),
 * --discover (sims may open threads with real participants),
 * --background (proactive introductions with channels; includes third suitable fixture),
 * --interval-ms N (default 4000), --no-server (agents only; server already up).
 */
async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const background = process.argv.includes('--background');
  const agents = background ? BACKGROUND_DEMO_AGENTS : DEMO_AGENTS;
  const env = liveEnv();
  if (live && !env) {
    console.error('demo:up --live requires META_API_KEY (or MODEL_API_KEY).');
    process.exit(1);
  }
  const intervalIdx = process.argv.indexOf('--interval-ms');
  const intervalMs = intervalIdx >= 0 ? Number.parseInt(process.argv[intervalIdx + 1] ?? '4000', 10) : 4000;
  const noServer = process.argv.includes('--no-server');
  const url = demoUrl();

  let child: ChildProcess | null = null;
  if (!noServer) {
    child = spawn('npx', ['tsx', 'src/server.ts'], {
      env: {
        ...process.env,
        MUPIT_PORT: String(demoPort()),
        MUPIT_DB_PATH: demoDbPath(),
        MUPIT_DEMO_MODE: '1',
        MUPIT_BACKGROUND_DEMO: background ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[demo-server] ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[demo-server] ${d}`));
    child.on('exit', (code) => {
      console.error(`demo server exited with code ${code}`);
      process.exit(code ?? 1);
    });
  }
  const shutdown = (): void => {
    console.log('\ndemo:up shutting down...');
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => child?.kill('SIGKILL'), 5000).unref();
    } else {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const killChild = (): void => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => child?.exitCode === null && child?.kill('SIGKILL'), 3000).unref();
    }
  };
  try {
    await waitForHealth(url, 30_000);
    if (child && child.exitCode !== null) {
      throw new Error(`demo server process exited during startup (code ${child.exitCode}); is port ${demoPort()} already in use by an orphaned server?`);
    }
    console.log(`demo server ready at ${url}`);
    await seedDemo(url, agents);
  } catch (err) {
    killChild();
    throw err;
  }

  const opts: TickOpts = {
    url,
    live,
    discover: background || process.argv.includes('--discover'),
    background,
    llm: live && env ? { apiKey: env.apiKey, baseUrl: env.baseUrl, model: env.model, timeoutMs: 45_000 } : null,
    maxThreadsPerTick: 5,
    maxLlmCallsPerTick: 6,
    maxResponsesPerThread: 12,
    log: (line) => console.log(line),
  };
  if (background) console.log('Background demo enabled: fictional agents proactively introduce themselves and share channel preferences; human consent is never automated.');
  console.log(`sim agents polling every ${intervalMs}ms (live=${live}). Ctrl-C to stop.`);
  for (;;) {
    await runAllTicks(agents, opts);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const invokedDirectly = process.argv[1]?.endsWith('/demo-up.ts') || process.argv[1]?.endsWith('/demo-up.js');
if (invokedDirectly) {
  main().catch((err) => {
    const status = (err as { code?: unknown })?.code;
    console.error(`demo:up failed: ${err instanceof Error ? err.message : String(err)}${status !== undefined ? ` (HTTP status ${String(status)})` : ''}`);
    process.exit(1);
  });
}
