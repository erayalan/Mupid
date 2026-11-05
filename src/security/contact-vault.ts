import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for per-match contact values (AES-256-GCM).
 * Sealed format: `v1.<base64(iv 12B || ciphertext || tag 16B)>`.
 * Failures throw; callers must fail closed and never delete data on key errors.
 */
export class ContactVault {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(key: Buffer, keyId = 'v1') {
    if (key.length !== 32) throw new Error('ContactVault requires a 32-byte key.');
    this.key = Buffer.from(key);
    this.keyId = keyId;
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${Buffer.concat([iv, ct, tag]).toString('base64')}`;
  }

  open(sealed: string): string {
    const [version, b64] = sealed.split('.');
    if (version !== 'v1' || !b64) throw new Error('Unsupported sealed-contact version.');
    const raw = Buffer.from(b64, 'base64');
    if (raw.length < 12 + 16 + 1) throw new Error('Malformed sealed contact.');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('Contact vault decryption failed: wrong or missing key. Data is preserved; fix the key, do not re-seed.');
    }
  }
}
