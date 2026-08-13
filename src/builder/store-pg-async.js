// PostgreSQL Builder Core store (async). Shared durable authority for
// independent Cursor Cloud agents. Never logs connection strings.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertApprovalStatus,
  assertCandidateStatus,
  assertEventType,
  assertFailureClass,
  assertRunStatus,
  assertTaskStatus,
  newEventId,
} from './contracts.js';
import { safeJsonStringify } from './secrets-redact.js';
import {
  nowIso,
  rowToApproval,
  rowToCandidate,
  rowToEvent,
  rowToLease,
  rowToReview,
  rowToRun,
  rowToTask,
  rowToVerification,
} from './store-rows.js';
import {
  BuilderStoreError,
  assertRunCannotRegainAuthority,
  isUniqueViolation,
} from './store-errors.js';
import { DEFAULT_LEASE_TTL_MS } from './store-target.js';
import { BUILDER_DATABASE_URL_ENV, BUILDER_SCHEMA_VERSION } from './store-schema.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function durableJson(value) {
  return value == null ? null : safeJsonStringify(value);
}

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  '57P01',
  '57P03',
  '08001',
  '08003',
  '08004',
  '08006',
]);

function isUnavailable(err) {
  if (!err) return false;
  if (UNAVAILABLE_CODES.has(String(err.code || ''))) return true;
  const msg = String(err.message || '');
  return /the database system is (starting up|shutting down)|connection.*refus|timeout expired|Client has encountered a connection error/i.test(
    msg
  );
}

function wrapUnavailable(err) {
  void err;
  throw new BuilderStoreError(
    'shared Builder store unavailable',
    'SHARED_STORE_UNAVAILABLE'
  );
}

async function queryPg(pool, text, params = []) {
  try {
    const result = await pool.query(toPg(text), params);
    return result.rows;
  } catch (err) {
    if (isUniqueViolation(err) || err?.code === 'STALE_RUN') throw err;
    if (err instanceof BuilderStoreError) throw err;
    if (isUnavailable(err)) wrapUnavailable(err);
    throw err;
  }
}

export class PostgresBuilderStoreAsync {
  constructor({ query, close, kind = 'postgres' }) {
    this.kind = kind;
    this.backend = 'postgres';
    this.dbPath = null;
    this._query = query;
    this._closeFn = close;
    this._closed = false;
  }

  static async connect(databaseUrl) {
    if (!databaseUrl || typeof databaseUrl !== 'string') {
      throw new BuilderStoreError(
        `${BUILDER_DATABASE_URL_ENV} is required for the shared Builder store`,
        'SHARED_STORE_UNAVAILABLE'
      );
    }
    let pg;
    try {
      pg = (await import('pg')).default;
    } catch (err) {
      wrapUnavailable(err);
    }
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 8,
      allowExitOnIdle: true,
    });
    const query = async (text, params = []) => queryPg(pool, text, params);
    const store = new PostgresBuilderStoreAsync({
      query,
      close: async () => {
        try {
          await pool.end();
        } catch {
          // ignore
        }
      },
    });
    try {
      await pool.query('SELECT 1 AS ok');
      await store.migrate();
    } catch (err) {
      try {
        await pool.end();
      } catch {
        // ignore
      }
      if (err instanceof BuilderStoreError) throw err;
      if (isUnavailable(err)) wrapUnavailable(err);
      throw err;
    }
    return store;
  }

  static async fromBackend(backend) {
    const query = async (text, params = []) => {
      try {
        if ((!params || params.length === 0) && typeof backend.exec === 'function' && text.includes(';')) {
          await backend.exec(text);
          return [];
        }
        const result = await backend.query(toPg(text), params);
        return result.rows || [];
      } catch (err) {
        if (isUniqueViolation(err) || err?.code === 'STALE_RUN') throw err;
        if (err instanceof BuilderStoreError) throw err;
        if (isUnavailable(err)) wrapUnavailable(err);
        throw err;
      }
    };
    const store = new PostgresBuilderStoreAsync({
      query,
      close: async () => {
        if (typeof backend.close === 'function') await backend.close();
      },
    });
    await store.migrate();
    return store;
  }

  async migrate() {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    await this._query(`
      CREATE SCHEMA IF NOT EXISTS builder
    `);
    await this._query(`
      CREATE TABLE IF NOT EXISTS builder.schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL,
        checksum_sha256 TEXT NOT NULL
      )
    `);
    const appliedRows = await this._query(
      `SELECT id FROM builder.schema_migrations`
    );
    const applied = new Set((appliedRows || []).map((row) => row.id));
    for (const file of files) {
      const id = file.replace(/\.sql$/, '');
      if (applied.has(id)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = sha256(sql);
      try {
        const statements = sql
          .split(';')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        for (const statement of statements) {
          await this._query(statement);
        }
        await this._query(
          `INSERT INTO builder.schema_migrations(id, applied_at, checksum_sha256)
           VALUES (?, ?, ?)`,
          [id, nowIso(), checksum]
        );
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        if (err instanceof BuilderStoreError) throw err;
        if (isUnavailable(err)) wrapUnavailable(err);
        throw err;
      }
    }
    await this._query(
      `INSERT INTO builder.builder_meta(key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['schema_version', BUILDER_SCHEMA_VERSION]
    );
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._closeFn) await this._closeFn();
  }

  async schemaVersion() {
    const rows = await this._query(
      `SELECT value FROM builder.builder_meta WHERE key = ?`,
      ['schema_version']
    );
    return rows[0]?.value ?? null;
  }

  async insertTask(task) {
    assertTaskStatus(task.status);
    const ts = task.created_at || nowIso();
    try {
      await this._query(
        `INSERT INTO builder.tasks(
           task_id, intent, intent_version, acceptance_ref, allowed_paths_json,
           tool_manifest_json, review_required, status, priority, max_attempts,
           max_runtime_ms, cost_budget_status, proposal_id, content_hash,
           locked_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
          task.updated_at || ts,
        ]
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BuilderStoreError(
          `duplicate task claim rejected: ${task.task_id}`,
          'DUPLICATE_CLAIM'
        );
      }
      throw err;
    }
    return this.getTask(task.task_id);
  }

  async tryInsertTask(task) {
    try {
      return await this.insertTask(task);
    } catch (err) {
      if (err instanceof BuilderStoreError && err.code === 'DUPLICATE_CLAIM') {
        return null;
      }
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  async getTask(taskId) {
    const rows = await this._query(
      `SELECT * FROM builder.tasks WHERE task_id = ?`,
      [taskId]
    );
    return rowToTask(rows[0]);
  }

  async listTasks() {
    const rows = await this._query(
      `SELECT * FROM builder.tasks ORDER BY created_at ASC`
    );
    return rows.map(rowToTask);
  }

  async updateTask(taskId, patch) {
    const current = await this.getTask(taskId);
    if (!current) throw new Error(`unknown task_id: ${taskId}`);
    const next = {
      ...current,
      ...patch,
      task_id: current.task_id,
      updated_at: nowIso(),
    };
    assertTaskStatus(next.status);
    await this._query(
      `UPDATE builder.tasks SET
         intent = ?, intent_version = ?, acceptance_ref = ?,
         allowed_paths_json = ?, tool_manifest_json = ?, review_required = ?,
         status = ?, priority = ?, max_attempts = ?, max_runtime_ms = ?,
         cost_budget_status = ?, proposal_id = ?, content_hash = ?,
         locked_at = ?, updated_at = ?
       WHERE task_id = ?`,
      [
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
        taskId,
      ]
    );
    return this.getTask(taskId);
  }

  async insertRun(run) {
    assertRunStatus(run.status);
    if (run.failure_class != null) assertFailureClass(run.failure_class);
    const created_at = run.created_at || nowIso();
    await this._query(
      `INSERT INTO builder.runs(
         factory_run_id, task_id, provider, provider_run_id, provider_agent_id,
         attempt, status, started_at, ended_at, failure_class, evidence_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        created_at,
      ]
    );
    return this.getRun(run.factory_run_id);
  }

  async getRun(factoryRunId) {
    const rows = await this._query(
      `SELECT * FROM builder.runs WHERE factory_run_id = ?`,
      [factoryRunId]
    );
    return rowToRun(rows[0]);
  }

  async listRunsForTask(taskId) {
    const rows = await this._query(
      `SELECT * FROM builder.runs WHERE task_id = ? ORDER BY attempt ASC`,
      [taskId]
    );
    return rows.map(rowToRun);
  }

  async updateRun(factoryRunId, patch) {
    const current = await this.getRun(factoryRunId);
    if (!current) throw new Error(`unknown factory_run_id: ${factoryRunId}`);
    assertRunCannotRegainAuthority(current, patch);
    const next = { ...current, ...patch, factory_run_id: current.factory_run_id };
    assertRunStatus(next.status);
    if (next.failure_class != null) assertFailureClass(next.failure_class);
    await this._query(
      `UPDATE builder.runs SET
         provider = ?, provider_run_id = ?, provider_agent_id = ?, attempt = ?,
         status = ?, started_at = ?, ended_at = ?, failure_class = ?,
         evidence_json = ?
       WHERE factory_run_id = ?`,
      [
        next.provider,
        next.provider_run_id ?? null,
        next.provider_agent_id ?? null,
        next.attempt,
        next.status,
        next.started_at ?? null,
        next.ended_at ?? null,
        next.failure_class ?? null,
        durableJson(next.evidence),
        factoryRunId,
      ]
    );
    return this.getRun(factoryRunId);
  }

  async listActiveRuns() {
    const rows = await this._query(
      `SELECT * FROM builder.runs
       WHERE status IN ('PENDING', 'LAUNCHED', 'RUNNING')
       ORDER BY created_at ASC`
    );
    return rows.map(rowToRun);
  }

  async insertCandidate(candidate) {
    assertCandidateStatus(candidate.status);
    const created_at = candidate.created_at || nowIso();
    await this._query(
      `INSERT INTO builder.candidates(
         candidate_id, task_id, factory_run_id, provider_run_id, branch,
         commit_sha, pr_number, pr_url, pr_ref, verification_ref, review_ref,
         ci_status, ci_conclusion, ci_ref, evidence_at, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
        created_at,
      ]
    );
    return this.getCandidate(candidate.candidate_id);
  }

  async getCandidate(candidateId) {
    const rows = await this._query(
      `SELECT * FROM builder.candidates WHERE candidate_id = ?`,
      [candidateId]
    );
    return rowToCandidate(rows[0]);
  }

  async updateCandidate(candidateId, patch) {
    const current = await this.getCandidate(candidateId);
    if (!current) throw new Error(`unknown candidate_id: ${candidateId}`);
    const next = { ...current, ...patch, candidate_id: current.candidate_id };
    assertCandidateStatus(next.status);
    await this._query(
      `UPDATE builder.candidates SET
         provider_run_id = ?, branch = ?, commit_sha = ?, pr_number = ?,
         pr_url = ?, pr_ref = ?, verification_ref = ?, review_ref = ?,
         ci_status = ?, ci_conclusion = ?, ci_ref = ?, evidence_at = ?,
         status = ?
       WHERE candidate_id = ?`,
      [
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
        candidateId,
      ]
    );
    return this.getCandidate(candidateId);
  }

  async listCandidatesForTask(taskId) {
    const rows = await this._query(
      `SELECT * FROM builder.candidates WHERE task_id = ? ORDER BY created_at ASC`,
      [taskId]
    );
    return rows.map(rowToCandidate);
  }

  async insertVerification(verification) {
    await this._query(
      `INSERT INTO builder.verifications(
         verification_id, candidate_id, commit_sha, result, checks_json,
         worker_claim, failure_class, created_at, invalidated_at,
         invalidation_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        verification.verification_id,
        verification.candidate_id,
        verification.commit_sha,
        verification.result,
        durableJson(verification.checks ?? []),
        verification.worker_claim ?? null,
        verification.failure_class ?? null,
        verification.created_at || nowIso(),
        verification.invalidated_at ?? null,
        verification.invalidation_reason ?? null,
      ]
    );
    return this.getVerification(verification.verification_id);
  }

  async getVerification(verificationId) {
    const rows = await this._query(
      `SELECT * FROM builder.verifications WHERE verification_id = ?`,
      [verificationId]
    );
    return rowToVerification(rows[0]);
  }

  async listVerificationsForCandidate(candidateId) {
    const rows = await this._query(
      `SELECT * FROM builder.verifications WHERE candidate_id = ? ORDER BY created_at ASC`,
      [candidateId]
    );
    return rows.map(rowToVerification);
  }

  async updateVerification(verificationId, patch) {
    const current = await this.getVerification(verificationId);
    if (!current) throw new Error(`unknown verification_id: ${verificationId}`);
    const next = {
      ...current,
      ...patch,
      verification_id: current.verification_id,
    };
    await this._query(
      `UPDATE builder.verifications SET
         result = ?, checks_json = ?, worker_claim = ?, failure_class = ?,
         invalidated_at = ?, invalidation_reason = ?
       WHERE verification_id = ?`,
      [
        next.result,
        durableJson(next.checks ?? []),
        next.worker_claim ?? null,
        next.failure_class ?? null,
        next.invalidated_at ?? null,
        next.invalidation_reason ?? null,
        verificationId,
      ]
    );
    return this.getVerification(verificationId);
  }

  async updateApproval(approvalId, patch) {
    const current = await this.getApproval(approvalId);
    if (!current) throw new Error(`unknown approval_id: ${approvalId}`);
    const next = { ...current, ...patch, approval_id: current.approval_id };
    assertApprovalStatus(next.status);
    await this._query(
      `UPDATE builder.approvals SET
         proposal_id = ?, content_hash = ?, candidate_id = ?, commit_sha = ?,
         approved_by = ?, approved_at = ?, status = ?
       WHERE approval_id = ?`,
      [
        next.proposal_id,
        next.content_hash,
        next.candidate_id ?? null,
        next.commit_sha ?? null,
        next.approved_by,
        next.approved_at,
        next.status,
        approvalId,
      ]
    );
    return this.getApproval(approvalId);
  }

  async insertReview(review) {
    await this._query(
      `INSERT INTO builder.reviews(
         review_id, candidate_id, commit_sha, review_status, findings_json,
         evidence_json, reviewed_at, invalidated_at, invalidation_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        review.review_id,
        review.candidate_id,
        review.commit_sha,
        review.review_status,
        durableJson(review.findings ?? []),
        durableJson(review.evidence),
        review.reviewed_at || nowIso(),
        review.invalidated_at ?? null,
        review.invalidation_reason ?? null,
      ]
    );
    return this.getReview(review.review_id);
  }

  async getReview(reviewId) {
    const rows = await this._query(
      `SELECT * FROM builder.reviews WHERE review_id = ?`,
      [reviewId]
    );
    return rowToReview(rows[0]);
  }

  async updateReview(reviewId, patch) {
    const current = await this.getReview(reviewId);
    if (!current) throw new Error(`unknown review_id: ${reviewId}`);
    const next = { ...current, ...patch, review_id: current.review_id };
    await this._query(
      `UPDATE builder.reviews SET
         review_status = ?, findings_json = ?, evidence_json = ?,
         reviewed_at = ?, invalidated_at = ?, invalidation_reason = ?
       WHERE review_id = ?`,
      [
        next.review_status,
        durableJson(next.findings ?? []),
        durableJson(next.evidence),
        next.reviewed_at,
        next.invalidated_at ?? null,
        next.invalidation_reason ?? null,
        reviewId,
      ]
    );
    return this.getReview(reviewId);
  }

  async listReviewsForCandidate(candidateId) {
    const rows = await this._query(
      `SELECT * FROM builder.reviews WHERE candidate_id = ? ORDER BY reviewed_at ASC`,
      [candidateId]
    );
    return rows.map(rowToReview);
  }

  async insertApproval(approval) {
    assertApprovalStatus(approval.status);
    await this._query(
      `INSERT INTO builder.approvals(
         approval_id, task_id, proposal_id, content_hash, candidate_id,
         commit_sha, approved_by, approved_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        approval.approval_id,
        approval.task_id,
        approval.proposal_id,
        approval.content_hash,
        approval.candidate_id ?? null,
        approval.commit_sha ?? null,
        approval.approved_by,
        approval.approved_at || nowIso(),
        approval.status,
      ]
    );
    return this.getApproval(approval.approval_id);
  }

  async getApproval(approvalId) {
    const rows = await this._query(
      `SELECT * FROM builder.approvals WHERE approval_id = ?`,
      [approvalId]
    );
    return rowToApproval(rows[0]);
  }

  async listApprovalsForTask(taskId) {
    const rows = await this._query(
      `SELECT * FROM builder.approvals WHERE task_id = ? ORDER BY approved_at ASC`,
      [taskId]
    );
    return rows.map(rowToApproval);
  }

  async appendEvent(event) {
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
    await this._query(
      `INSERT INTO builder.events(
         event_id, task_id, factory_run_id, event_type, evidence_ref,
         payload_json, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.event_id,
        record.task_id,
        record.factory_run_id,
        record.event_type,
        record.evidence_ref,
        durableJson(record.payload),
        record.timestamp,
      ]
    );
    const rows = await this._query(
      `SELECT * FROM builder.events WHERE event_id = ?`,
      [record.event_id]
    );
    return rowToEvent(rows[0]);
  }

  async listEventsForTask(taskId) {
    const rows = await this._query(
      `SELECT * FROM builder.events WHERE task_id = ? ORDER BY timestamp ASC, event_id ASC`,
      [taskId]
    );
    return rows.map(rowToEvent);
  }

  async tryAcquireLease(leaseKey, owner, {
    now = nowIso(),
    ttlMs = DEFAULT_LEASE_TTL_MS,
  } = {}) {
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    const rows = await this._query(
      `INSERT INTO builder.builder_leases(
         lease_key, owner, fencing_token, acquired_at, expires_at
       ) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (lease_key) DO UPDATE SET
         owner = EXCLUDED.owner,
         fencing_token = builder.builder_leases.fencing_token + 1,
         acquired_at = EXCLUDED.acquired_at,
         expires_at = EXCLUDED.expires_at
       WHERE builder.builder_leases.expires_at < EXCLUDED.acquired_at
       RETURNING *`,
      [leaseKey, String(owner), now, expiresAt]
    );
    return rowToLease(rows[0]) || null;
  }

  async releaseLease(leaseKey, owner) {
    await this._query(
      `DELETE FROM builder.builder_leases WHERE lease_key = ? AND owner = ?`,
      [leaseKey, String(owner)]
    );
  }

  async reconstruct() {
    const tasks = await this.listTasks();
    const nonterminal = tasks.filter(
      (t) => !['ACCEPTED', 'FAILED', 'CANCELLED'].includes(t.status)
    );
    const runs = [];
    const candidates = [];
    const approvals = [];
    const events = [];
    for (const task of nonterminal) {
      runs.push(...(await this.listRunsForTask(task.task_id)));
      candidates.push(...(await this.listCandidatesForTask(task.task_id)));
      approvals.push(...(await this.listApprovalsForTask(task.task_id)));
      events.push(...(await this.listEventsForTask(task.task_id)));
    }
    return {
      schema_version: await this.schemaVersion(),
      store_backend: this.kind,
      tasks,
      nonterminal_tasks: nonterminal,
      runs,
      candidates,
      approvals,
      events,
    };
  }
}
