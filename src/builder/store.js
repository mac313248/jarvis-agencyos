// src/builder/store.js
// Durable Builder Core state (SQLite). Restart-safe for task/run/candidate/
// approval/event records. Not the AgencyOS business store.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  assertApprovalStatus,
  assertCandidateStatus,
  assertEventType,
  assertFailureClass,
  assertRunStatus,
  assertTaskStatus,
  newEventId,
} from './contracts.js';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
const SCHEMA_VERSION = 'builder-stage1-v4';

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  return JSON.parse(text);
}

function rowToTask(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    intent: row.intent,
    intent_version: row.intent_version,
    acceptance_ref: row.acceptance_ref,
    allowed_paths: parseJson(row.allowed_paths_json, []),
    tool_manifest: parseJson(row.tool_manifest_json, {}),
    review_required: Boolean(row.review_required),
    status: row.status,
    priority: row.priority,
    max_attempts: row.max_attempts == null ? 2 : Number(row.max_attempts),
    max_runtime_ms:
      row.max_runtime_ms == null ? 1800000 : Number(row.max_runtime_ms),
    cost_budget_status: row.cost_budget_status || 'UNKNOWN',
    proposal_id: row.proposal_id,
    content_hash: row.content_hash,
    locked_at: row.locked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToReview(row) {
  if (!row) return null;
  return {
    review_id: row.review_id,
    candidate_id: row.candidate_id,
    commit_sha: row.commit_sha,
    review_status: row.review_status,
    findings: parseJson(row.findings_json, []),
    evidence: parseJson(row.evidence_json, null),
    reviewed_at: row.reviewed_at,
    invalidated_at: row.invalidated_at,
    invalidation_reason: row.invalidation_reason,
  };
}

function rowToRun(row) {
  if (!row) return null;
  return {
    factory_run_id: row.factory_run_id,
    task_id: row.task_id,
    provider: row.provider,
    provider_run_id: row.provider_run_id,
    provider_agent_id: row.provider_agent_id ?? null,
    attempt: row.attempt,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    failure_class: row.failure_class,
    evidence: parseJson(row.evidence_json, null),
    created_at: row.created_at,
  };
}

function rowToCandidate(row) {
  if (!row) return null;
  return {
    candidate_id: row.candidate_id,
    task_id: row.task_id,
    factory_run_id: row.factory_run_id,
    provider_run_id: row.provider_run_id ?? null,
    branch: row.branch,
    commit_sha: row.commit_sha,
    pr_number: row.pr_number == null ? null : Number(row.pr_number),
    pr_url: row.pr_url ?? null,
    pr_ref: row.pr_ref,
    verification_ref: row.verification_ref,
    review_ref: row.review_ref,
    ci_status: row.ci_status ?? null,
    ci_conclusion: row.ci_conclusion ?? null,
    ci_ref: row.ci_ref,
    evidence_at: row.evidence_at ?? null,
    status: row.status,
    created_at: row.created_at,
  };
}

function rowToVerification(row) {
  if (!row) return null;
  return {
    verification_id: row.verification_id,
    candidate_id: row.candidate_id,
    commit_sha: row.commit_sha,
    result: row.result,
    checks: parseJson(row.checks_json, []),
    worker_claim: row.worker_claim,
    failure_class: row.failure_class,
    created_at: row.created_at,
    invalidated_at: row.invalidated_at,
    invalidation_reason: row.invalidation_reason,
  };
}

function rowToApproval(row) {
  if (!row) return null;
  return {
    approval_id: row.approval_id,
    task_id: row.task_id,
    proposal_id: row.proposal_id,
    content_hash: row.content_hash,
    candidate_id: row.candidate_id,
    commit_sha: row.commit_sha,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    status: row.status,
  };
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    event_id: row.event_id,
    task_id: row.task_id,
    factory_run_id: row.factory_run_id,
    event_type: row.event_type,
    evidence_ref: row.evidence_ref,
    payload: parseJson(row.payload_json, null),
    timestamp: row.timestamp,
  };
}

export class BuilderStore {
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    this._migrateRunsColumns();
    this.db
      .prepare(
        `INSERT INTO builder_meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run('schema_version', SCHEMA_VERSION);
  }

  _migrateRunsColumns() {
    const runCols = this.db.prepare(`PRAGMA table_info(runs)`).all().map((c) => c.name);
    if (!runCols.includes('provider_agent_id')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN provider_agent_id TEXT`);
    }
    if (!runCols.includes('evidence_json')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN evidence_json TEXT`);
    }
    const candCols = this.db.prepare(`PRAGMA table_info(candidates)`).all().map((c) => c.name);
    for (const [col, type] of [
      ['provider_run_id', 'TEXT'],
      ['pr_number', 'INTEGER'],
      ['pr_url', 'TEXT'],
      ['ci_status', 'TEXT'],
      ['ci_conclusion', 'TEXT'],
      ['evidence_at', 'TEXT'],
    ]) {
      if (!candCols.includes(col)) {
        this.db.exec(`ALTER TABLE candidates ADD COLUMN ${col} ${type}`);
      }
    }
    const taskCols = this.db.prepare(`PRAGMA table_info(tasks)`).all().map((c) => c.name);
    for (const [col, type] of [
      ['max_attempts', 'INTEGER NOT NULL DEFAULT 2'],
      ['max_runtime_ms', 'INTEGER NOT NULL DEFAULT 1800000'],
      ['cost_budget_status', "TEXT NOT NULL DEFAULT 'UNKNOWN'"],
    ]) {
      if (!taskCols.includes(col)) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
      }
    }
  }

  close() {
    this.db.close();
  }

  schemaVersion() {
    const row = this.db
      .prepare(`SELECT value FROM builder_meta WHERE key = ?`)
      .get('schema_version');
    return row?.value ?? null;
  }

  insertTask(task) {
    assertTaskStatus(task.status);
    const ts = task.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks(
           task_id, intent, intent_version, acceptance_ref, allowed_paths_json,
           tool_manifest_json, review_required, status, priority, max_attempts,
           max_runtime_ms, cost_budget_status, proposal_id, content_hash,
           locked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.task_id,
        task.intent,
        task.intent_version,
        task.acceptance_ref,
        JSON.stringify(task.allowed_paths ?? []),
        JSON.stringify(task.tool_manifest ?? {}),
        task.review_required ? 1 : 0,
        task.status,
        task.priority ?? 100,
        task.max_attempts ?? 2,
        task.max_runtime_ms ?? 1800000,
        task.cost_budget_status || 'UNKNOWN',
        task.proposal_id ?? null,
        task.content_hash ?? null,
        task.locked_at ?? null,
        ts,
        task.updated_at || ts
      );
    return this.getTask(task.task_id);
  }

  getTask(taskId) {
    return rowToTask(
      this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(taskId)
    );
  }

  listTasks() {
    return this.db
      .prepare(`SELECT * FROM tasks ORDER BY created_at ASC`)
      .all()
      .map(rowToTask);
  }

  updateTask(taskId, patch) {
    const current = this.getTask(taskId);
    if (!current) throw new Error(`unknown task_id: ${taskId}`);
    const next = {
      ...current,
      ...patch,
      task_id: current.task_id,
      updated_at: nowIso(),
    };
    assertTaskStatus(next.status);
    this.db
      .prepare(
        `UPDATE tasks SET
           intent = ?, intent_version = ?, acceptance_ref = ?,
           allowed_paths_json = ?, tool_manifest_json = ?, review_required = ?,
           status = ?, priority = ?, max_attempts = ?, max_runtime_ms = ?,
           cost_budget_status = ?, proposal_id = ?, content_hash = ?,
           locked_at = ?, updated_at = ?
         WHERE task_id = ?`
      )
      .run(
        next.intent,
        next.intent_version,
        next.acceptance_ref,
        JSON.stringify(next.allowed_paths ?? []),
        JSON.stringify(next.tool_manifest ?? {}),
        next.review_required ? 1 : 0,
        next.status,
        next.priority,
        next.max_attempts ?? 2,
        next.max_runtime_ms ?? 1800000,
        next.cost_budget_status || 'UNKNOWN',
        next.proposal_id ?? null,
        next.content_hash ?? null,
        next.locked_at ?? null,
        next.updated_at,
        taskId
      );
    return this.getTask(taskId);
  }

  insertRun(run) {
    assertRunStatus(run.status);
    if (run.failure_class != null) assertFailureClass(run.failure_class);
    const created_at = run.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO runs(
           factory_run_id, task_id, provider, provider_run_id, provider_agent_id,
           attempt, status, started_at, ended_at, failure_class, evidence_json,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.factory_run_id,
        run.task_id,
        run.provider,
        run.provider_run_id ?? null,
        run.provider_agent_id ?? null,
        run.attempt,
        run.status,
        run.started_at ?? null,
        run.ended_at ?? null,
        run.failure_class ?? null,
        run.evidence == null ? null : JSON.stringify(run.evidence),
        created_at
      );
    return this.getRun(run.factory_run_id);
  }

  getRun(factoryRunId) {
    return rowToRun(
      this.db
        .prepare(`SELECT * FROM runs WHERE factory_run_id = ?`)
        .get(factoryRunId)
    );
  }

  listRunsForTask(taskId) {
    return this.db
      .prepare(`SELECT * FROM runs WHERE task_id = ? ORDER BY attempt ASC`)
      .all(taskId)
      .map(rowToRun);
  }

  updateRun(factoryRunId, patch) {
    const current = this.getRun(factoryRunId);
    if (!current) throw new Error(`unknown factory_run_id: ${factoryRunId}`);
    const next = { ...current, ...patch, factory_run_id: current.factory_run_id };
    assertRunStatus(next.status);
    if (next.failure_class != null) assertFailureClass(next.failure_class);
    this.db
      .prepare(
        `UPDATE runs SET
           provider = ?, provider_run_id = ?, provider_agent_id = ?, attempt = ?,
           status = ?, started_at = ?, ended_at = ?, failure_class = ?,
           evidence_json = ?
         WHERE factory_run_id = ?`
      )
      .run(
        next.provider,
        next.provider_run_id ?? null,
        next.provider_agent_id ?? null,
        next.attempt,
        next.status,
        next.started_at ?? null,
        next.ended_at ?? null,
        next.failure_class ?? null,
        next.evidence == null ? null : JSON.stringify(next.evidence),
        factoryRunId
      );
    return this.getRun(factoryRunId);
  }

  listActiveRuns() {
    return this.db
      .prepare(
        `SELECT * FROM runs
         WHERE status IN ('PENDING', 'LAUNCHED', 'RUNNING')
         ORDER BY created_at ASC`
      )
      .all()
      .map(rowToRun);
  }

  insertCandidate(candidate) {
    assertCandidateStatus(candidate.status);
    const created_at = candidate.created_at || nowIso();
    this.db
      .prepare(
        `INSERT INTO candidates(
           candidate_id, task_id, factory_run_id, provider_run_id, branch,
           commit_sha, pr_number, pr_url, pr_ref, verification_ref, review_ref,
           ci_status, ci_conclusion, ci_ref, evidence_at, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        candidate.candidate_id,
        candidate.task_id,
        candidate.factory_run_id,
        candidate.provider_run_id ?? null,
        candidate.branch ?? null,
        candidate.commit_sha ?? null,
        candidate.pr_number ?? null,
        candidate.pr_url ?? null,
        candidate.pr_ref ?? null,
        candidate.verification_ref ?? null,
        candidate.review_ref ?? null,
        candidate.ci_status ?? null,
        candidate.ci_conclusion ?? null,
        candidate.ci_ref ?? null,
        candidate.evidence_at ?? null,
        candidate.status,
        created_at
      );
    return this.getCandidate(candidate.candidate_id);
  }

  getCandidate(candidateId) {
    return rowToCandidate(
      this.db
        .prepare(`SELECT * FROM candidates WHERE candidate_id = ?`)
        .get(candidateId)
    );
  }

  updateCandidate(candidateId, patch) {
    const current = this.getCandidate(candidateId);
    if (!current) throw new Error(`unknown candidate_id: ${candidateId}`);
    const next = { ...current, ...patch, candidate_id: current.candidate_id };
    assertCandidateStatus(next.status);
    this.db
      .prepare(
        `UPDATE candidates SET
           provider_run_id = ?, branch = ?, commit_sha = ?, pr_number = ?,
           pr_url = ?, pr_ref = ?, verification_ref = ?, review_ref = ?,
           ci_status = ?, ci_conclusion = ?, ci_ref = ?, evidence_at = ?,
           status = ?
         WHERE candidate_id = ?`
      )
      .run(
        next.provider_run_id ?? null,
        next.branch ?? null,
        next.commit_sha ?? null,
        next.pr_number ?? null,
        next.pr_url ?? null,
        next.pr_ref ?? null,
        next.verification_ref ?? null,
        next.review_ref ?? null,
        next.ci_status ?? null,
        next.ci_conclusion ?? null,
        next.ci_ref ?? null,
        next.evidence_at ?? null,
        next.status,
        candidateId
      );
    return this.getCandidate(candidateId);
  }

  listCandidatesForTask(taskId) {
    return this.db
      .prepare(
        `SELECT * FROM candidates WHERE task_id = ? ORDER BY created_at ASC`
      )
      .all(taskId)
      .map(rowToCandidate);
  }

  insertVerification(verification) {
    this.db
      .prepare(
        `INSERT INTO verifications(
           verification_id, candidate_id, commit_sha, result, checks_json,
           worker_claim, failure_class, created_at, invalidated_at,
           invalidation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        verification.verification_id,
        verification.candidate_id,
        verification.commit_sha,
        verification.result,
        JSON.stringify(verification.checks ?? []),
        verification.worker_claim ?? null,
        verification.failure_class ?? null,
        verification.created_at || nowIso(),
        verification.invalidated_at ?? null,
        verification.invalidation_reason ?? null
      );
    return this.getVerification(verification.verification_id);
  }

  getVerification(verificationId) {
    return rowToVerification(
      this.db
        .prepare(`SELECT * FROM verifications WHERE verification_id = ?`)
        .get(verificationId)
    );
  }

  updateVerification(verificationId, patch) {
    const current = this.getVerification(verificationId);
    if (!current) throw new Error(`unknown verification_id: ${verificationId}`);
    const next = {
      ...current,
      ...patch,
      verification_id: current.verification_id,
    };
    this.db
      .prepare(
        `UPDATE verifications SET
           result = ?, checks_json = ?, worker_claim = ?, failure_class = ?,
           invalidated_at = ?, invalidation_reason = ?
         WHERE verification_id = ?`
      )
      .run(
        next.result,
        JSON.stringify(next.checks ?? []),
        next.worker_claim ?? null,
        next.failure_class ?? null,
        next.invalidated_at ?? null,
        next.invalidation_reason ?? null,
        verificationId
      );
    return this.getVerification(verificationId);
  }

  updateApproval(approvalId, patch) {
    const current = this.getApproval(approvalId);
    if (!current) throw new Error(`unknown approval_id: ${approvalId}`);
    const next = { ...current, ...patch, approval_id: current.approval_id };
    assertApprovalStatus(next.status);
    this.db
      .prepare(
        `UPDATE approvals SET
           proposal_id = ?, content_hash = ?, candidate_id = ?, commit_sha = ?,
           approved_by = ?, approved_at = ?, status = ?
         WHERE approval_id = ?`
      )
      .run(
        next.proposal_id,
        next.content_hash,
        next.candidate_id ?? null,
        next.commit_sha ?? null,
        next.approved_by,
        next.approved_at,
        next.status,
        approvalId
      );
    return this.getApproval(approvalId);
  }

  insertReview(review) {
    this.db
      .prepare(
        `INSERT INTO reviews(
           review_id, candidate_id, commit_sha, review_status, findings_json,
           evidence_json, reviewed_at, invalidated_at, invalidation_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        review.review_id,
        review.candidate_id,
        review.commit_sha,
        review.review_status,
        JSON.stringify(review.findings ?? []),
        review.evidence == null ? null : JSON.stringify(review.evidence),
        review.reviewed_at || nowIso(),
        review.invalidated_at ?? null,
        review.invalidation_reason ?? null
      );
    return this.getReview(review.review_id);
  }

  getReview(reviewId) {
    return rowToReview(
      this.db.prepare(`SELECT * FROM reviews WHERE review_id = ?`).get(reviewId)
    );
  }

  updateReview(reviewId, patch) {
    const current = this.getReview(reviewId);
    if (!current) throw new Error(`unknown review_id: ${reviewId}`);
    const next = { ...current, ...patch, review_id: current.review_id };
    this.db
      .prepare(
        `UPDATE reviews SET
           review_status = ?, findings_json = ?, evidence_json = ?,
           reviewed_at = ?, invalidated_at = ?, invalidation_reason = ?
         WHERE review_id = ?`
      )
      .run(
        next.review_status,
        JSON.stringify(next.findings ?? []),
        next.evidence == null ? null : JSON.stringify(next.evidence),
        next.reviewed_at,
        next.invalidated_at ?? null,
        next.invalidation_reason ?? null,
        reviewId
      );
    return this.getReview(reviewId);
  }

  listReviewsForCandidate(candidateId) {
    return this.db
      .prepare(
        `SELECT * FROM reviews WHERE candidate_id = ? ORDER BY reviewed_at ASC`
      )
      .all(candidateId)
      .map(rowToReview);
  }

  insertApproval(approval) {
    assertApprovalStatus(approval.status);
    this.db
      .prepare(
        `INSERT INTO approvals(
           approval_id, task_id, proposal_id, content_hash, candidate_id,
           commit_sha, approved_by, approved_at, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        approval.approval_id,
        approval.task_id,
        approval.proposal_id,
        approval.content_hash,
        approval.candidate_id ?? null,
        approval.commit_sha ?? null,
        approval.approved_by,
        approval.approved_at || nowIso(),
        approval.status
      );
    return this.getApproval(approval.approval_id);
  }

  getApproval(approvalId) {
    return rowToApproval(
      this.db
        .prepare(`SELECT * FROM approvals WHERE approval_id = ?`)
        .get(approvalId)
    );
  }

  listApprovalsForTask(taskId) {
    return this.db
      .prepare(
        `SELECT * FROM approvals WHERE task_id = ? ORDER BY approved_at ASC`
      )
      .all(taskId)
      .map(rowToApproval);
  }

  appendEvent(event) {
    assertEventType(event.event_type);
    const record = {
      event_id: event.event_id || newEventId(),
      task_id: event.task_id ?? null,
      factory_run_id: event.factory_run_id ?? null,
      event_type: event.event_type,
      evidence_ref: event.evidence_ref ?? null,
      payload: event.payload ?? null,
      timestamp: event.timestamp || nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO events(
           event_id, task_id, factory_run_id, event_type, evidence_ref,
           payload_json, timestamp
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.event_id,
        record.task_id,
        record.factory_run_id,
        record.event_type,
        record.evidence_ref,
        record.payload == null ? null : JSON.stringify(record.payload),
        record.timestamp
      );
    return rowToEvent(
      this.db
        .prepare(`SELECT * FROM events WHERE event_id = ?`)
        .get(record.event_id)
    );
  }

  listEventsForTask(taskId) {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE task_id = ? ORDER BY timestamp ASC, event_id ASC`
      )
      .all(taskId)
      .map(rowToEvent);
  }

  // Reconstruct nonterminal Builder state after restart.
  reconstruct() {
    const tasks = this.listTasks();
    const nonterminal = tasks.filter(
      (t) =>
        !['ACCEPTED', 'FAILED', 'CANCELLED'].includes(t.status)
    );
    return {
      schema_version: this.schemaVersion(),
      tasks,
      nonterminal_tasks: nonterminal,
      runs: nonterminal.flatMap((t) => this.listRunsForTask(t.task_id)),
      candidates: nonterminal.flatMap((t) =>
        this.listCandidatesForTask(t.task_id)
      ),
      approvals: nonterminal.flatMap((t) =>
        this.listApprovalsForTask(t.task_id)
      ),
      events: nonterminal.flatMap((t) => this.listEventsForTask(t.task_id)),
    };
  }
}

export function openBuilderStore(dbPath = ':memory:') {
  return new BuilderStore(dbPath);
}
