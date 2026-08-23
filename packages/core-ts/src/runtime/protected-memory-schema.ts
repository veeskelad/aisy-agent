export const PROTECTED_LEDGER_SCHEMA_VERSION = 2

export const PROTECTED_LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  operator_id TEXT,
  profile_id TEXT,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project')),
  scope_id TEXT NOT NULL,
  project_id TEXT,
  source_sha256 TEXT,
  migration_id TEXT,
  started_at TEXT NOT NULL,
  forget_count INTEGER NOT NULL DEFAULT 0 CHECK (forget_count >= 0),
  forget_head_hash TEXT NOT NULL DEFAULT 'genesis',
  CHECK (
    (operator_id IS NULL AND profile_id IS NULL) OR
    (operator_id IS NOT NULL AND profile_id IS NOT NULL)
  ),
  CHECK (
    (scope_kind = 'global' AND scope_id = 'global' AND project_id IS NULL) OR
    (scope_kind = 'project' AND project_id IS NOT NULL AND scope_id = 'project:' || project_id)
  )
);
CREATE TABLE IF NOT EXISTS facts (
  rowid INTEGER PRIMARY KEY,
  operation_id TEXT UNIQUE,
  id TEXT UNIQUE NOT NULL,
  text TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  key_tokens TEXT NOT NULL,
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  is_human_confirmed INTEGER NOT NULL CHECK (is_human_confirmed IN (0, 1)),
  source_authority INTEGER,
  confidence REAL,
  provenance TEXT NOT NULL,
  supersedes TEXT,
  contradicts TEXT,
  extends_key TEXT,
  published INTEGER NOT NULL CHECK (published IN (0, 1)),
  source_path TEXT,
  content_hash TEXT,
  CHECK (published = 0 OR (source_path IS NOT NULL AND content_hash IS NOT NULL)),
  CHECK (operation_id IS NULL OR (source_path IS NOT NULL AND content_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_ledger_facts_key ON facts(fact_key);
CREATE TABLE IF NOT EXISTS do_not_remember (
  rowid INTEGER PRIMARY KEY,
  operation_id TEXT UNIQUE,
  fact_key TEXT NOT NULL,
  key_tokens TEXT NOT NULL,
  reason TEXT NOT NULL,
  is_human_confirmed INTEGER NOT NULL CHECK (is_human_confirmed IN (0, 1)),
  ts TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  row_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_publication_wal (
  operation_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  wal_json TEXT NOT NULL,
  wal_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_outbox (
  event_id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1))
);
CREATE TABLE IF NOT EXISTS memory_deletion_wal (
  operation_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  wal_json TEXT NOT NULL,
  wal_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_deletion_audit_outbox (
  event_id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1))
);
CREATE TABLE IF NOT EXISTS memory_update_wal (
  operation_id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  wal_json TEXT NOT NULL,
  wal_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_update_audit_outbox (
  event_id TEXT PRIMARY KEY,
  event_json TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1))
);
`

export const PROTECTED_KEYWORD_SCHEMA = `
CREATE TABLE IF NOT EXISTS keyword_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  operator_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project')),
  scope_id TEXT NOT NULL,
  project_id TEXT,
  CHECK (
    (scope_kind = 'global' AND scope_id = 'global' AND project_id IS NULL) OR
    (scope_kind = 'project' AND project_id IS NOT NULL AND scope_id = 'project:' || project_id)
  )
);
CREATE TABLE IF NOT EXISTS keyword_metadata (
  rowid INTEGER PRIMARY KEY,
  operation_id TEXT UNIQUE NOT NULL,
  fact_id TEXT UNIQUE NOT NULL,
  fact_key TEXT NOT NULL,
  source_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS keyword_fts USING fts5(text);
`
