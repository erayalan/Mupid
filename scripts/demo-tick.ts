import { runAllTicks, type TickOpts } from '../demo/agents/runner.js';
import { BACKGROUND_DEMO_AGENTS, DEMO_AGENTS, demoUrl, liveEnv } from './demo-env.js';

/**
 * `npm run demo:tick` — advance all simulated agents by ONE bounded cycle
 * (deterministic recording/control). Use --live for real Meta-model replies
 * (requires META_API_KEY); default is labeled scripted replies.
 * Use --discover to let sims open threads with real (non-simulated) participants.
 */
const invokedDirectly = process.argv[1]?.endsWith('/demo-tick.ts') || process.argv[1]?.endsWith('/demo-tick.js');
if (invokedDirectly) {
  const live = process.argv.includes('--live');
  const background = process.argv.includes('--background');
  const env = liveEnv();
  if (live && !env) {
    console.error('demo:tick --live requires META_API_KEY (or MODEL_API_KEY).');
    process.exit(1);
  }
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);
  const opts: TickOpts = {
    url: demoUrl(),
    live,
    discover: background || process.argv.includes('--discover'),
    background,
    llm: live && env ? { apiKey: env.apiKey, baseUrl: env.baseUrl, model: env.model, timeoutMs: 45_000 } : null,
    maxThreadsPerTick: 5,
    maxLlmCallsPerTick: 6,
    maxResponsesPerThread: 12,
    log: (line) => console.log(line),
  };
  console.log(`demo:tick url=${opts.url} live=${live} discover=${opts.discover}`);
  runAllTicks(only ?? (background ? BACKGROUND_DEMO_AGENTS : DEMO_AGENTS), opts).then(() => console.log('demo:tick done')).catch((err) => {
    console.error(`demo:tick failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
