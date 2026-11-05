/** Shared demo-script environment helpers (not a command). */
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env — explicit environment only */
}

export const DEMO_AGENTS = ['wren', 'sam', 'jules', 'theo', 'noor'];
export const BACKGROUND_DEMO_AGENTS = [...DEMO_AGENTS, 'leo', 'mira', 'ivy', 'elena'];

export function demoPort(): number {
  return Number.parseInt(process.env.MUPIT_DEMO_PORT ?? '3001', 10);
}

export function demoUrl(): string {
  return process.env.MUPIT_DEMO_URL ?? `http://127.0.0.1:${demoPort()}/mcp`;
}

export function demoDbPath(): string {
  return process.env.MUPIT_DEMO_DB_PATH ?? 'demo/state/demo.db';
}

export interface LiveEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function liveEnv(): LiveEnv | null {
  const apiKey = process.env.META_API_KEY?.trim() || process.env.MODEL_API_KEY?.trim() || '';
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.META_BASE_URL?.trim() || 'https://api.meta.ai/v1').replace(/\/+$/, ''),
    model: process.env.META_MODEL?.trim() || 'muse-spark-1.3',
  };
}

export async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const healthUrl = baseUrl.replace(/\/mcp\/?$/, '') + '/healthz';
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) return (await res.json()) as Record<string, unknown>;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${healthUrl} not ready after ${timeoutMs}ms (last: ${lastErr}).`);
}
