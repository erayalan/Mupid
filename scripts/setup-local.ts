import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/**
 * `npm run setup:local` — initialize private local secrets WITHOUT
 * overwriting existing keys (regenerating would strand derived tokens
 * and sealed contacts).
 */
function ensureSecret(path: string, label: string): void {
  if (existsSync(path)) {
    console.log(`keep  ${label} ${path} (exists; not overwritten)`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
  console.log(`wrote ${label} ${path} (mode 0600)`);
}

const serverSecretFile = process.env.MUPIT_SERVER_SECRET_FILE ?? 'data/.server-secret';
const vaultKeyFile = process.env.MUPIT_VAULT_KEY_FILE ?? 'data/.vault-key';
ensureSecret(serverSecretFile, 'server secret');
ensureSecret(vaultKeyFile, 'vault key');
console.log('done. Copy .env.example to .env (gitignored) and set META_API_KEY for live facilitation.');
