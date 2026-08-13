-- Builder Core control-plane schema (PostgreSQL).
-- Separate trust domain from AgencyOS Business Core. Applied only to
-- Applied only to the Builder control-plane database, never AgencyOS business credentials.

CREATE SCHEMA IF NOT EXISTS builder;

CREATE TABLE IF NOT EXISTS builder.schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS builder.builder_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS builder.tasks (
  task_id TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  intent_version INTEGER NOT NULL,
  acceptance_ref TEXT NOT NULL,
  allowed_paths_json TEXT NOT NULL,
  tool_manifest_json TEXT NOT NULL,
  review_required SMALLINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  max_runtime_ms INTEGER NOT NULL DEFAULT 1800000,
  cost_budget_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  proposal_id TEXT,
  content_hash TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (intent_version >= 1),
  CHECK (review_required IN (0, 1)),
  CHECK (max_attempts >= 1)
);

CREATE TABLE IF NOT EXISTS builder.runs (
  factory_run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES builder.tasks(task_id),
  provider TEXT NOT NULL,
  provider_run_id TEXT,
  provider_agent_id TEXT,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  failure_class TEXT,
  evidence_json TEXT,
  created_at TEXT NOT NULL,
  CHECK (attempt >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS runs_task_attempt_uq
  ON builder.runs(task_id, attempt);

CREATE TABLE IF NOT EXISTS builder.candidates (
  candidate_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES builder.tasks(task_id),
  factory_run_id TEXT NOT NULL REFERENCES builder.runs(factory_run_id),
  provider_run_id TEXT,
  branch TEXT,
  commit_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_ref TEXT,
  verification_ref TEXT,
  review_ref TEXT,
  ci_status TEXT,
  ci_conclusion TEXT,
  ci_ref TEXT,
  evidence_at TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS builder.verifications (
  verification_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES builder.candidates(candidate_id),
  commit_sha TEXT NOT NULL,
  result TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  worker_claim TEXT,
  failure_class TEXT,
  created_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT
);

CREATE TABLE IF NOT EXISTS builder.reviews (
  review_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES builder.candidates(candidate_id),
  commit_sha TEXT NOT NULL,
  review_status TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  evidence_json TEXT,
  reviewed_at TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT
);

CREATE TABLE IF NOT EXISTS builder.approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES builder.tasks(task_id),
  proposal_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  candidate_id TEXT,
  commit_sha TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS builder.events (
  event_id TEXT PRIMARY KEY,
  task_id TEXT,
  factory_run_id TEXT,
  event_type TEXT NOT NULL,
  evidence_ref TEXT,
  payload_json TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_task_ts_idx
  ON builder.events(task_id, timestamp);

CREATE TABLE IF NOT EXISTS builder.builder_leases (
  lease_key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
