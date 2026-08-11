-- Builder Core Stage-1 durable schema (SQLite).
-- Separate trust domain from AgencyOS Business Core (Postgres/RLS).
-- No tenant/customer/business-write authority lives here.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS builder_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  intent_version INTEGER NOT NULL,
  acceptance_ref TEXT NOT NULL,
  allowed_paths_json TEXT NOT NULL,
  tool_manifest_json TEXT NOT NULL,
  review_required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  proposal_id TEXT,
  content_hash TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (intent_version >= 1),
  CHECK (review_required IN (0, 1))
);

CREATE TABLE IF NOT EXISTS runs (
  factory_run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  provider TEXT NOT NULL,
  provider_run_id TEXT,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  failure_class TEXT,
  created_at TEXT NOT NULL,
  CHECK (attempt >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_task_attempt_uq
  ON runs(task_id, attempt);

CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  factory_run_id TEXT NOT NULL REFERENCES runs(factory_run_id),
  branch TEXT,
  commit_sha TEXT,
  pr_ref TEXT,
  verification_ref TEXT,
  review_ref TEXT,
  ci_ref TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  proposal_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  candidate_id TEXT,
  commit_sha TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT,
  factory_run_id TEXT,
  event_type TEXT NOT NULL,
  evidence_ref TEXT,
  payload_json TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_task_ts_idx
  ON events(task_id, timestamp);
