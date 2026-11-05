import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface MupitConfig {
  host: string;
  port: number;
  /** One explicitly trusted public tunnel hostname; listening stays loopback-only. */
  tunnelHost?: string;
  dbPath: string;
  serverSecret: Buffer; // 32 bytes; registration-token derivation
  vaultKey: Buffer; // 32 bytes; AES-256-GCM contact vault
  vaultKeyId: string;
  metaApiKey: string | null;
  metaModel: string;
  metaBaseUrl: string;
  facilitatorMode: 'live' | 'mock';
  demoMode: boolean;
  backgroundDemo?: boolean;
  automaticMediation?: boolean;
  maxMessageChars: number;
  maxIntroChars: number;
  defaultPageLimit: number;
  maxPageLimit: number;
  writeRateLimitPerMin: number;
  facilitatorTimeoutMs: number;
  facilitatorMaxOutputTokens: number;
}

export function parseTunnelHost(raw: string | undefined): string | undefined {
  const host = raw?.trim().toLowerCase();
  if (!host) return undefined;
  if (host.length > 253 || !host.includes('.') || !host.split('.').every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  )) {
    throw new Error('MUPIT_TUNNEL_HOST must be one exact hostname, without a scheme, port, path, or wildcard.');
  }
  return host;
}

function readSecretFile(path: string): Buffer | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return null;
    return Buffer.from(raw, 'base64');
  } catch {
    return null;
  }
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let envFileLoaded = false;

/** Load .env once (explicit environment always wins over file values). */
function loadEnvFileOnce(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env — explicit environment only */
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MupitConfig {
  if (env === process.env) loadEnvFileOnce();
  const host = env.MUPIT_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error(`Refusing to bind non-loopback host "${host}". Mupit is local-only.`);
  }
  const port = Number.parseInt(env.MUPIT_PORT ?? '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid MUPIT_PORT`);
  const tunnelHost = parseTunnelHost(env.MUPIT_TUNNEL_HOST);
  const dbPath = env.MUPIT_DB_PATH ?? 'data/mupit.db';
  ensureParentDir(dbPath);

  // Server secret: file wins when present, else env-provided base64.
  const secretFile = env.MUPIT_SERVER_SECRET_FILE ?? 'data/.server-secret';
  let serverSecret = readSecretFile(secretFile);
  if (!serverSecret && env.MUPIT_SERVER_SECRET) {
    serverSecret = Buffer.from(env.MUPIT_SERVER_SECRET.trim(), 'base64');
  }
  if (!serverSecret || serverSecret.length !== 32) {
    throw new Error(
      `Missing/invalid server secret (need 32 bytes). Run \`npm run setup:local\` to generate ${secretFile}, ` +
        `or set MUPIT_SERVER_SECRET to base64 of 32 random bytes.`,
    );
  }

  const vaultFile = env.MUPIT_VAULT_KEY_FILE ?? 'data/.vault-key';
  let vaultKey = readSecretFile(vaultFile);
  if (!vaultKey && env.MUPIT_VAULT_KEY) {
    vaultKey = Buffer.from(env.MUPIT_VAULT_KEY.trim(), 'base64');
  }
  if (!vaultKey || vaultKey.length !== 32) {
    throw new Error(
      `Missing/invalid vault key (need 32 bytes). Run \`npm run setup:local\` to generate ${vaultFile}, ` +
        `or set MUPIT_VAULT_KEY to base64 of 32 random bytes.`,
    );
  }

  const metaApiKey = env.META_API_KEY?.trim() || env.MODEL_API_KEY?.trim() || null;
  const metaModel = env.META_MODEL?.trim() || 'muse-spark-1.3';
  const metaBaseUrl = (env.META_BASE_URL?.trim() || 'https://api.meta.ai/v1').replace(/\/+$/, '');
  const facilitatorMode = (env.MUPIT_FACILITATOR_MODE ?? 'live').toLowerCase() === 'mock' ? 'mock' : 'live';
  const demoMode = env.MUPIT_DEMO_MODE === '1' || env.MUPIT_DEMO_MODE?.toLowerCase() === 'true';

  return {
    host,
    port,
    ...(tunnelHost ? { tunnelHost } : {}),
    dbPath,
    serverSecret,
    vaultKey,
    vaultKeyId: 'v1',
    metaApiKey,
    metaModel,
    metaBaseUrl,
    facilitatorMode,
    demoMode,
    backgroundDemo: demoMode && env.MUPIT_BACKGROUND_DEMO === '1',
    automaticMediation: env.MUPIT_AUTO_MEDIATION !== '0',
    maxMessageChars: 4000,
    maxIntroChars: 1500,
    defaultPageLimit: 20,
    maxPageLimit: 50,
    writeRateLimitPerMin: 120,
    facilitatorTimeoutMs: 60_000,
    // Completion budget includes internal reasoning as well as the JSON answer.
    facilitatorMaxOutputTokens: 8192,
  };
}

/** Safe subset for logs/health: never includes secrets. */
export function publicConfigSummary(cfg: MupitConfig): Record<string, unknown> {
  return {
    host: cfg.host,
    port: cfg.port,
    tunnelHost: cfg.tunnelHost ?? null,
    metaModel: cfg.metaModel,
    metaBaseUrl: cfg.metaBaseUrl,
    metaKeyConfigured: cfg.metaApiKey !== null,
    facilitatorMode: cfg.facilitatorMode,
    demoMode: cfg.demoMode,
    backgroundDemo: cfg.demoMode && cfg.backgroundDemo === true,
    automaticMediation: cfg.automaticMediation !== false,
  };
}
