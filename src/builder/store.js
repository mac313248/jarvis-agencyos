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
  newFactoryRunId,
} from './contracts.js';
import { safeJsonStringify } from './secrets-redact.js';
import {
  rowToApproval,
  rowToCandidate,
  rowToEvent,
  rowToLease,
  rowToReview,
  rowToRun,
  rowToTask,
  rowToVerification,
} from './store-mappers.js';
import {
  ACTIVE_CODING_LEASE_KEY,
  BUILDER_STORE_KIND,
  isUniqueViolation,
} from './store-config.js';
import { createAndLockTask } from './task-lock.js';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
export const SCHEMA_VERSION = 'builder-stage1-v6';
const ACTIVE_RUN_STATUSES = new Set(['PENDING', 'LAUNCHED', 'RUNNING']);

function nowIso() {
  return new Date().toISOString();
}

function durableJson(value) {
  return value == null ? null : safeJsonStringify(value);
}

export class BuilderStore {
  constructor(dbPath = ':memory:') {
    this.kind = BUILDER_STORE_KIND.SQLITE;
    this.async = false;
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
      ['logical_work_id', 'TEXT'],
    ]) {
      if (!taskCols.includes(col)) {
        this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${type}`);
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS builder_leases (
        lease_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        task_id TEXT,
        factory_run_id TEXT,
        acquired_at TEXT NOT NULL
      );
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_logical_work_id_uq
        ON tasks(logical_work_id)
        WHERE logical_work_id IS NOT NULL;
    `);
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
           task_id, logical_work_id, intent, intent_version, acceptance_ref,
           allowed_paths_json, tool_manifest_json, review_required, status,
           priority, max_attempts, max_runtime_ms, cost_budget_status,
           proposal_id, content_hash, locked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.task_id,
        task.logical_work_id ?? null,
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

  getTaskByLogicalWorkId(logicalWorkId) {
    if (!logicalWorkId) return null;
    return rowToTask(
      this.db
        .prepare(`SELECT * FROM tasks WHERE logical_work_id = ?`)
        .get(logicalWorkId)
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
           logical_work_id = ?, intent = ?, intent_version = ?, acceptance_ref = ?,
           allowed_paths_json = ?, tool_manifest_json = ?, review_required = ?,
           status = ?, priority = ?, max_attempts = ?, max_runtime_ms = ?,
           cost_budget_status = ?, proposal_id = ?, content_hash = ?,
           locked_at = ?, updated_at = ?
         WHERE task_id = ?`
      )
      .run(
        next.logical_work_id ?? null,
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
        durableJson(run.evidence),
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
        durableJson(next.evidence),
        factoryRunId
      );
    if (!ACTIVE_RUN_STATUSES.has(next.status)) {
      this.releaseControlLeaseByRun(factoryRunId);
    }
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
        durableJson(verification.checks ?? []),
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

  listVerificationsForCandidate(candidateId) {
    return this.db
      .prepare(
        `SELECT * FROM verifications WHERE candidate_id = ? ORDER BY created_at ASC`
      )
      .all(candidateId)
      .map(rowToVerification);
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
        durableJson(next.checks ?? []),
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
        durableJson(review.findings ?? []),
        durableJson(review.evidence),
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
        durableJson(next.findings ?? []),
        durableJson(next.evidence),
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
        durableJson(record.payload),
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

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  getControlLease(leaseKey) {
    return rowToLease(
      this.db
        .prepare(`SELECT * FROM builder_leases WHERE lease_key = ?`)
        .get(leaseKey)
    );
  }

  acquireControlLease({
    key = ACTIVE_CODING_LEASE_KEY,
    owner,
    task_id = null,
    factory_run_id = null,
  }) {
    return this.tx(() => {
      const existing = this.getControlLease(key);
      if (existing) {
        if (existing.owner === owner) {
          this.db
            .prepare(
              `UPDATE builder_leases SET task_id = ?, factory_run_id = ?, acquired_at = ?
               WHERE lease_key = ?`
            )
            .run(
              task_id ?? existing.task_id,
              factory_run_id ?? existing.factory_run_id,
              nowIso(),
              key
            );
          return { acquired: true, refreshed: true, lease: this.getControlLease(key) };
        }
        return { acquired: false, reason: 'LEASE_HELD', lease: existing };
      }
      this.db
        .prepare(
          `INSERT INTO builder_leases(lease_key, owner, task_id, factory_run_id, acquired_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(key, owner, task_id, factory_run_id, nowIso());
      return { acquired: true, refreshed: false, lease: this.getControlLease(key) };
    });
  }

  releaseControlLease(key = ACTIVE_CODING_LEASE_KEY, owner = null) {
    if (owner) {
      this.db
        .prepare(`DELETE FROM builder_leases WHERE lease_key = ? AND owner = ?`)
        .run(key, owner);
      return;
    }
    this.db.prepare(`DELETE FROM builder_leases WHERE lease_key = ?`).run(key);
  }

  releaseControlLeaseByRun(factoryRunId) {
    this.db
      .prepare(`DELETE FROM builder_leases WHERE factory_run_id = ?`)
      .run(factoryRunId);
  }

  claimLogicalWork(input) {
    try {
      return this.tx(() => {
        const existing =
          this.getTask(input.task_id) ||
          this.getTaskByLogicalWorkId(input.logical_work_id);
        if (existing) {
          return {
            claimed: false,
            already_claimed: true,
            task: existing,
            reason: 'ALREADY_CLAIMED',
          };
        }
        const task = createAndLockTask(this, input);
        return { claimed: true, already_claimed: false, task };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const task =
          this.getTask(input.task_id) ||
          this.getTaskByLogicalWorkId(input.logical_work_id);
        return {
          claimed: false,
          already_claimed: true,
          task,
          reason: 'ALREADY_CLAIMED',
        };
      }
      throw err;
    }
  }

  tryInsertActiveRun({
    task_id,
    provider,
    owner,
    factory_run_id = null,
    provider_run_id = null,
    provider_agent_id = null,
    attempt = null,
  }) {
    try {
      return this.tx(() => {
        const lease = this.getControlLease(ACTIVE_CODING_LEASE_KEY);
        if (lease && lease.owner !== owner) {
          const existing = lease.factory_run_id
            ? this.getRun(lease.factory_run_id)
            : this.listActiveRuns()[0] || null;
          return {
            inserted: false,
            reason: 'LEASE_HELD',
            run: existing,
            lease,
          };
        }
        const existingActive = this.listRunsForTask(task_id).filter((r) =>
          ACTIVE_RUN_STATUSES.has(r.status)
        );
        if (existingActive.length > 0) {
          return {
            inserted: false,
            reason: 'ACTIVE_RUN_EXISTS',
            run: existingActive[0],
            lease,
          };
        }
        const existing = this.listRunsForTask(task_id);
        const nextAttempt = attempt ?? existing.length + 1;
        const run = this.insertRun({
          factory_run_id: factory_run_id || newFactoryRunId(),
          task_id,
          provider,
          provider_run_id,
          provider_agent_id,
          attempt: nextAttempt,
          status: 'PENDING',
          started_at: null,
          ended_at: null,
          failure_class: null,
          evidence: null,
        });
        if (lease && lease.owner === owner) {
          this.db
            .prepare(
              `UPDATE builder_leases SET task_id = ?, factory_run_id = ?, acquired_at = ?
               WHERE lease_key = ?`
            )
            .run(task_id, run.factory_run_id, nowIso(), ACTIVE_CODING_LEASE_KEY);
        } else {
          this.db
            .prepare(
              `INSERT INTO builder_leases(lease_key, owner, task_id, factory_run_id, acquired_at)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(
              ACTIVE_CODING_LEASE_KEY,
              owner,
              task_id,
              run.factory_run_id,
              nowIso()
            );
        }
        return { inserted: true, run };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const active = this.listActiveRuns()[0] || null;
        const taskRuns = this.listRunsForTask(task_id);
        return {
          inserted: false,
          reason: 'UNIQUE_CONSTRAINT',
          run: active || taskRuns[taskRuns.length - 1] || null,
        };
      }
      throw err;
    }
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
