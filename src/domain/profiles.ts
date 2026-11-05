import type { DatabaseSync } from 'node:sqlite';
import type { MupitConfig } from '../config.js';
import { Store, canonicalJson, parseIntro, parsePrefs, type ParticipantRow } from '../db/store.js';
import { MupitError, notFound, unauthorized, validation, versionConflict } from './errors.js';
import { IntroductionSchema, PreferencesSchema } from './schemas.js';
import { detectIdentifiers } from './identifiers.js';
import { deriveRegistrationToken, hashKey, hashToken, randomId, sha256Hex } from '../security/tokens.js';

export interface RegistrationInput {
  registration_key: string;
  introduction: unknown;
  preferences: unknown;
  adult_attested: boolean;
  publication_confirmed: boolean;
  /** Demo provisioning only: mark as simulated. Honored solely in demo mode. */
  simulated?: boolean | undefined;
}

export interface RegistrationResult {
  participant_id: string;
  participant_token: string;
  introduction_version: number;
  returning_registration: boolean;
}

function scanPublicText(fields: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(fields)) {
    const texts = Array.isArray(value) ? (value as unknown[]).map(String) : [String(value ?? '')];
    for (const text of texts) {
      const hits = detectIdentifiers(text);
      if (hits.length > 0) {
        throw validation(`Field "${name}" appears to contain identifying contact info (${hits.join(', ')}). ` +
          `Introductions must stay pseudonymous; contact details are exchanged only through the per-match contact tools.`);
      }
    }
  }
}

/** Authenticate a caller from their Bearer [REDACTED] Never trust a supplied sender ID. */
export function authenticate(db: DatabaseSync, token: string): ParticipantRow {
  const store = new Store(db);
  const row = store.getParticipantByTokenHash(hashToken(token));
  if (!row) throw unauthorized();
  return row;
}

export function registerParticipant(db: DatabaseSync, cfg: MupitConfig, input: RegistrationInput): RegistrationResult {
  if (input.adult_attested !== true) {
    throw validation('Adult self-attestation (age 18+) is required to register.', undefined);
  }
  if (input.publication_confirmed !== true) {
    throw validation('Explicit human approval of the exact published introduction is required (publication_confirmed=true).');
  }
  const intro = IntroductionSchema.parse(input.introduction);
  const prefs = PreferencesSchema.parse(input.preferences);
  scanPublicText({
    about_me: intro.about_me,
    looking_for: intro.looking_for,
    region: intro.region,
    interests: intro.interests,
    values: intro.values,
    lifestyle: intro.lifestyle,
    dealbreakers: intro.dealbreakers,
    gender: prefs.gender ?? '',
  });

  const payloadHash = sha256Hex(canonicalJson({ introduction: intro, preferences: prefs }));
  const store = new Store(db);
  const keyHash = hashKey(input.registration_key);
  const token = deriveRegistrationToken(cfg.serverSecret, input.registration_key);

  return store.transaction(() => {
    const existing = store.getParticipantByRegKeyHash(keyHash);
    if (existing) {
      if (existing.reg_payload_hash !== payloadHash) {
        throw new MupitError(
          'VERSION_CONFLICT',
          'This registration key was already used with different content. Registration keys are single-use per identity; generate a fresh key for a new identity.',
        );
      }
      return {
        participant_id: existing.id,
        participant_token: token,
        introduction_version: existing.version,
        returning_registration: true,
      };
    }
    const id = randomId('p');
    const isSimulated = cfg.demoMode && input.simulated === true ? 1 : 0;
    store.insertParticipant({
      id,
      token_hash: hashToken(token),
      reg_key_hash: keyHash,
      reg_payload_hash: payloadHash,
      intro_json: JSON.stringify(intro),
      prefs_json: JSON.stringify(prefs),
      version: 1,
      is_active: 1,
      is_simulated: isSimulated,
    });
    return { participant_id: id, participant_token: token, introduction_version: 1, returning_registration: false };
  });
}

export function getSelf(db: DatabaseSync, callerId: string): Record<string, unknown> {
  const store = new Store(db);
  const row = store.getParticipantById(callerId);
  if (!row) throw notFound('participant');
  return {
    participant_id: row.id,
    introduction: parseIntro(row),
    preferences: parsePrefs(row),
    introduction_version: row.version,
    is_active: row.is_active === 1,
    is_simulated: row.is_simulated === 1,
  };
}

export interface UpdateIntroductionInput {
  expected_version: number;
  introduction: unknown;
  preferences: unknown;
  publication_confirmed: boolean;
}

export function updateIntroduction(db: DatabaseSync, callerId: string, input: UpdateIntroductionInput): Record<string, unknown> {
  if (input.publication_confirmed !== true) {
    throw validation('Explicit human approval of the exact replacement introduction is required (publication_confirmed=true).');
  }
  const intro = IntroductionSchema.parse(input.introduction);
  const prefs = PreferencesSchema.parse(input.preferences);
  scanPublicText({
    about_me: intro.about_me,
    looking_for: intro.looking_for,
    region: intro.region,
    interests: intro.interests,
    values: intro.values,
    lifestyle: intro.lifestyle,
    dealbreakers: intro.dealbreakers,
    gender: prefs.gender ?? '',
  });
  const store = new Store(db);
  return store.transaction(() => {
    const row = store.getParticipantById(callerId);
    if (!row) throw notFound('participant');
    if (row.version !== input.expected_version) {
      throw versionConflict(`Expected introduction version ${input.expected_version}, current is ${row.version}.`, {
        current_version: row.version,
      });
    }
    store.updateIntroduction(callerId, JSON.stringify(intro), JSON.stringify(prefs), row.version + 1);
    // Profile versions are part of every pair context fingerprint: bump open threads.
    for (const conv of store.listConversationsFor(callerId)) {
      if (conv.status === 'active') store.bumpRevision(conv.id);
    }
    return { participant_id: callerId, introduction_version: row.version + 1 };
  });
}

export function setActive(db: DatabaseSync, callerId: string, active: boolean): Record<string, unknown> {
  const store = new Store(db);
  return store.transaction(() => {
    const row = store.getParticipantById(callerId);
    if (!row) throw notFound('participant');
    store.setActive(callerId, active);
    return { participant_id: callerId, is_active: active };
  });
}
