import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 2;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  reg_key_hash TEXT NOT NULL UNIQUE,
  reg_payload_hash TEXT NOT NULL,
  intro_json TEXT NOT NULL,
  prefs_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_simulated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 1,
  facil_last_input_rev INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (a_id, b_id),
  FOREIGN KEY (a_id) REFERENCES participants(id),
  FOREIGN KEY (b_id) REFERENCES participants(id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sender_role TEXT NOT NULL,
  sender_participant_id TEXT,
  addressed_ids_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS assessments (
  conversation_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  assessment TEXT NOT NULL,
  rationale TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, participant_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS connection_proposals (
  conversation_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  channel TEXT NOT NULL,
  proposer_id TEXT NOT NULL,
  approvals_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS contact_submissions (
  conversation_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  participant_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sealed_value TEXT NOT NULL,
  key_id TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  provenance TEXT NOT NULL,
  PRIMARY KEY (conversation_id, proposal_version, participant_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (recipient_id) REFERENCES participants(id)
);
CREATE INDEX IF NOT EXISTS idx_events_recipient ON events(recipient_id, id);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS facilitator_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  input_rev INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  action TEXT,
  message_id TEXT,
  latency_ms INTEGER,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, input_rev),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS facilitator_assessments (
  run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  input_rev INTEGER NOT NULL,
  action TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  tensions_json TEXT NOT NULL,
  unknowns_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE TABLE IF NOT EXISTS idempotency (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, operation, request_id)
);
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS mediation_jobs (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  input_seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS mediation_jobs_due ON mediation_jobs(status, next_attempt_at);
`;

export function utcNow(): string {
  return new Date().toISOString();
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);');
  const row = db.prepare('SELECT MAX(version) AS v FROM migrations').get() as { v: number | null };
  const current = row.v ?? 0;
  if (current < 1) {
    db.exec(MIGRATION_1);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (1, ?)').run(utcNow());
  }
  if (current < 2) {
    db.exec(MIGRATION_2);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (2, ?)').run(utcNow());
  }
  // Future migrations: append `if (current < N)` blocks; never edit MIGRATION_1.
  return db;
}
