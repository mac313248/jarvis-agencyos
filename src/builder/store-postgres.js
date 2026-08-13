// PostgreSQL Builder Core store. Same caller surface as SQLite BuilderStore,
// but every method is async. Dedicated schema `jarvis_builder` — not AgencyOS.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
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
  BuilderStoreConfigError,
  assertSafeSchemaName,
  isUniqueViolation,
} from './store-config.js';
import { createAndLockTask } from './task-lock.js';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.postgres.sql');
const SCHEMA_VERSION = 'builder-stage1-v6';
const ACTIVE_RUN_STATUSES = new Set(['PENDING', 'LAUNCHED', 'RUNNING']);
const txStorage = new AsyncLocalStorage();

function nowIso() {
  return new Date().toISOString();
}

function durableJson(value) {
  return value == null ? null : safeJsonStringify(value);
}

export class PostgresBuilderStore {
  constructor(pool, { schema = 'jarvis_builder', databaseUrl = null } = {}) {
    this.kind = BUILDER_STORE_KIND.POSTGRES;
    this.async = true;
    this.schema = assertSafeSchemaName(schema);
    this.pool = pool;
    this.databaseUrl = databaseUrl;
    this.dbPath = null;
  }

  async _query(text, params = []) {
    const client = txStorage.getStore();
    if (client) return client.query(text, params);
    return this.pool.query(text, params);
  }

  async tx(fn) {
    const existing = txStorage.getStore();
    if (existing) return fn();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run(client, () => fn());
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    await this.pool.end();
  }

  async schemaVersion() {
    const result = await this._query(
      `SELECT value FROM builder_meta WHERE key = $1`,
      ['schema_version']
    );
    return result.rows[0]?.value ?? null;
  }

  async insertTask(task) {
    assertTaskStatus(task.status);
    const ts = task.created_at || nowIso();
    await this._query(
      `INSERT INTO tasks(
         task_id, logical_work_id, intent, intent_version, acceptance_ref,
         allowed_paths_json, tool_manifest_json, review_required, status,
         priority, max_attempts, max_runtime_ms, cost_budget_status,
         proposal_id, content_hash, locked_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
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
        task.updated_at || ts,
      ]
    );
    return this.getTask(task.task_id);
  }

  async getTask(taskId) {
    const result = await this._query(`SELECT * FROM tasks WHERE task_id = $1`, [taskId]);
    return rowToTask(result.rows[0]);
  }

  async getTaskByLogicalWorkId(logicalWorkId) {
    if (!logicalWorkId) return null;
    const result = await this._query(
      `SELECT * FROM tasks WHERE logical_work_id = $1`,
      [logicalWorkId]
    );
    return rowToTask(result.rows[0]);
  }

  async listTasks() {
    const result = await this._query(`SELECT * FROM tasks ORDER BY created_at ASC`);
    return result.rows.map(rowToTask);
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
      `UPDATE tasks SET
         logical_work_id = $1, intent = $2, intent_version = $3, acceptance_ref = $4,
         allowed_paths_json = $5, tool_manifest_json = $6, review_required = $7,
         status = $8, priority = $9, max_attempts = $10, max_runtime_ms = $11,
         cost_budget_status = $12, proposal_id = $13, content_hash = $14,
         locked_at = $15, updated_at = $16
       WHERE task_id = $17`,
      [
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
      `INSERT INTO runs(
         factory_run_id, task_id, provider, provider_run_id, provider_agent_id,
         attempt, status, started_at, ended_at, failure_class, evidence_json,
         created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
    const result = await this._query(
      `SELECT * FROM runs WHERE factory_run_id = $1`,
      [factoryRunId]
    );
    return rowToRun(result.rows[0]);
  }

  async listRunsForTask(taskId) {
    const result = await this._query(
      `SELECT * FROM runs WHERE task_id = $1 ORDER BY attempt ASC`,
      [taskId]
    );
    return result.rows.map(rowToRun);
  }

  async updateRun(factoryRunId, patch) {
    const current = await this.getRun(factoryRunId);
    if (!current) throw new Error(`unknown factory_run_id: ${factoryRunId}`);
    const next = { ...current, ...patch, factory_run_id: current.factory_run_id };
    assertRunStatus(next.status);
    if (next.failure_class != null) assertFailureClass(next.failure_class);
    await this._query(
      `UPDATE runs SET
         provider = $1, provider_run_id = $2, provider_agent_id = $3, attempt = $4,
         status = $5, started_at = $6, ended_at = $7, failure_class = $8,
         evidence_json = $9
       WHERE factory_run_id = $10`,
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
    if (!ACTIVE_RUN_STATUSES.has(next.status)) {
      await this.releaseControlLeaseByRun(factoryRunId);
    }
    return this.getRun(factoryRunId);
  }

  async listActiveRuns() {
    const result = await this._query(
      `SELECT * FROM runs
       WHERE status IN ('PENDING', 'LAUNCHED', 'RUNNING')
       ORDER BY created_at ASC`
    );
    return result.rows.map(rowToRun);
  }

  async insertCandidate(candidate) {
    assertCandidateStatus(candidate.status);
    const created_at = candidate.created_at || nowIso();
    await this._query(
      `INSERT INTO candidates(
         candidate_id, task_id, factory_run_id, provider_run_id, branch,
         commit_sha, pr_number, pr_url, pr_ref, verification_ref, review_ref,
         ci_status, ci_conclusion, ci_ref, evidence_at, status, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
    const result = await this._query(
      `SELECT * FROM candidates WHERE candidate_id = $1`,
      [candidateId]
    );
    return rowToCandidate(result.rows[0]);
  }

  async updateCandidate(candidateId, patch) {
    const current = await this.getCandidate(candidateId);
    if (!current) throw new Error(`unknown candidate_id: ${candidateId}`);
    const next = { ...current, ...patch, candidate_id: current.candidate_id };
    assertCandidateStatus(next.status);
    await this._query(
      `UPDATE candidates SET
         provider_run_id = $1, branch = $2, commit_sha = $3, pr_number = $4,
         pr_url = $5, pr_ref = $6, verification_ref = $7, review_ref = $8,
         ci_status = $9, ci_conclusion = $10, ci_ref = $11, evidence_at = $12,
         status = $13
       WHERE candidate_id = $14`,
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
    const result = await this._query(
      `SELECT * FROM candidates WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId]
    );
    return result.rows.map(rowToCandidate);
  }

  async insertVerification(verification) {
    await this._query(
      `INSERT INTO verifications(
         verification_id, candidate_id, commit_sha, result, checks_json,
         worker_claim, failure_class, created_at, invalidated_at,
         invalidation_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
    const result = await this._query(
      `SELECT * FROM verifications WHERE verification_id = $1`,
      [verificationId]
    );
    return rowToVerification(result.rows[0]);
  }

  async listVerificationsForCandidate(candidateId) {
    const result = await this._query(
      `SELECT * FROM verifications WHERE candidate_id = $1 ORDER BY created_at ASC`,
      [candidateId]
    );
    return result.rows.map(rowToVerification);
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
      `UPDATE verifications SET
         result = $1, checks_json = $2, worker_claim = $3, failure_class = $4,
         invalidated_at = $5, invalidation_reason = $6
       WHERE verification_id = $7`,
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

  async insertReview(review) {
    await this._query(
      `INSERT INTO reviews(
         review_id, candidate_id, commit_sha, review_status, findings_json,
         evidence_json, reviewed_at, invalidated_at, invalidation_reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
    const result = await this._query(
      `SELECT * FROM reviews WHERE review_id = $1`,
      [reviewId]
    );
    return rowToReview(result.rows[0]);
  }

  async updateReview(reviewId, patch) {
    const current = await this.getReview(reviewId);
    if (!current) throw new Error(`unknown review_id: ${reviewId}`);
    const next = { ...current, ...patch, review_id: current.review_id };
    await this._query(
      `UPDATE reviews SET
         review_status = $1, findings_json = $2, evidence_json = $3,
         reviewed_at = $4, invalidated_at = $5, invalidation_reason = $6
       WHERE review_id = $7`,
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
    const result = await this._query(
      `SELECT * FROM reviews WHERE candidate_id = $1 ORDER BY reviewed_at ASC`,
      [candidateId]
    );
    return result.rows.map(rowToReview);
  }

  async insertApproval(approval) {
    assertApprovalStatus(approval.status);
    await this._query(
      `INSERT INTO approvals(
         approval_id, task_id, proposal_id, content_hash, candidate_id,
         commit_sha, approved_by, approved_at, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
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
    const result = await this._query(
      `SELECT * FROM approvals WHERE approval_id = $1`,
      [approvalId]
    );
    return rowToApproval(result.rows[0]);
  }

  async updateApproval(approvalId, patch) {
    const current = await this.getApproval(approvalId);
    if (!current) throw new Error(`unknown approval_id: ${approvalId}`);
    const next = { ...current, ...patch, approval_id: current.approval_id };
    assertApprovalStatus(next.status);
    await this._query(
      `UPDATE approvals SET
         proposal_id = $1, content_hash = $2, candidate_id = $3, commit_sha = $4,
         approved_by = $5, approved_at = $6, status = $7
       WHERE approval_id = $8`,
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

  async listApprovalsForTask(taskId) {
    const result = await this._query(
      `SELECT * FROM approvals WHERE task_id = $1 ORDER BY approved_at ASC`,
      [taskId]
    );
    return result.rows.map(rowToApproval);
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
      `INSERT INTO events(
         event_id, task_id, factory_run_id, event_type, evidence_ref,
         payload_json, timestamp
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
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
    const result = await this._query(
      `SELECT * FROM events WHERE event_id = $1`,
      [record.event_id]
    );
    return rowToEvent(result.rows[0]);
  }

  async listEventsForTask(taskId) {
    const result = await this._query(
      `SELECT * FROM events WHERE task_id = $1 ORDER BY timestamp ASC, event_id ASC`,
      [taskId]
    );
    return result.rows.map(rowToEvent);
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
    for (const t of nonterminal) {
      runs.push(...(await this.listRunsForTask(t.task_id)));
      candidates.push(...(await this.listCandidatesForTask(t.task_id)));
      approvals.push(...(await this.listApprovalsForTask(t.task_id)));
      events.push(...(await this.listEventsForTask(t.task_id)));
    }
    return {
      schema_version: await this.schemaVersion(),
      tasks,
      nonterminal_tasks: nonterminal,
      runs,
      candidates,
      approvals,
      events,
    };
  }

  async getControlLease(leaseKey) {
    const result = await this._query(
      `SELECT * FROM builder_leases WHERE lease_key = $1 FOR UPDATE`,
      [leaseKey]
    );
    return rowToLease(result.rows[0]);
  }

  async acquireControlLease({
    key = ACTIVE_CODING_LEASE_KEY,
    owner,
    task_id = null,
    factory_run_id = null,
  }) {
    return this.tx(async () => {
      const existing = await this.getControlLease(key);
      if (existing) {
        if (existing.owner === owner) {
          await this._query(
            `UPDATE builder_leases SET task_id = $1, factory_run_id = $2, acquired_at = $3
             WHERE lease_key = $4`,
            [task_id ?? existing.task_id, factory_run_id ?? existing.factory_run_id, nowIso(), key]
          );
          return {
            acquired: true,
            refreshed: true,
            lease: await this.getControlLease(key),
          };
        }
        return { acquired: false, reason: 'LEASE_HELD', lease: existing };
      }
      await this._query(
        `INSERT INTO builder_leases(lease_key, owner, task_id, factory_run_id, acquired_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [key, owner, task_id, factory_run_id, nowIso()]
      );
      return { acquired: true, refreshed: false, lease: await this.getControlLease(key) };
    });
  }

  async releaseControlLease(key = ACTIVE_CODING_LEASE_KEY, owner = null) {
    if (owner) {
      await this._query(
        `DELETE FROM builder_leases WHERE lease_key = $1 AND owner = $2`,
        [key, owner]
      );
      return;
    }
    await this._query(`DELETE FROM builder_leases WHERE lease_key = $1`, [key]);
  }

  async releaseControlLeaseByRun(factoryRunId) {
    await this._query(`DELETE FROM builder_leases WHERE factory_run_id = $1`, [factoryRunId]);
  }

  async claimLogicalWork(input) {
    try {
      return await this.tx(async () => {
        const existing =
          (await this.getTask(input.task_id)) ||
          (await this.getTaskByLogicalWorkId(input.logical_work_id));
        if (existing) {
          await this._query(
            `SELECT task_id FROM tasks WHERE task_id = $1 FOR UPDATE`,
            [existing.task_id]
          );
          return {
            claimed: false,
            already_claimed: true,
            task: existing,
            reason: 'ALREADY_CLAIMED',
          };
        }
        const task = await createAndLockTask(this, input);
        return { claimed: true, already_claimed: false, task };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const task =
          (await this.getTask(input.task_id)) ||
          (await this.getTaskByLogicalWorkId(input.logical_work_id));
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

  async tryInsertActiveRun({
    task_id,
    provider,
    owner,
    factory_run_id = null,
    provider_run_id = null,
    provider_agent_id = null,
    attempt = null,
  }) {
    try {
      return await this.tx(async () => {
        const lease = await this.getControlLease(ACTIVE_CODING_LEASE_KEY);
        if (lease && lease.owner !== owner) {
          const existing = lease.factory_run_id
            ? await this.getRun(lease.factory_run_id)
            : (await this.listActiveRuns())[0] || null;
          return {
            inserted: false,
            reason: 'LEASE_HELD',
            run: existing,
            lease,
          };
        }
        const existingActive = (await this.listRunsForTask(task_id)).filter((r) =>
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
        const existing = await this.listRunsForTask(task_id);
        const nextAttempt = attempt ?? existing.length + 1;
        const run = await this.insertRun({
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
          await this._query(
            `UPDATE builder_leases SET task_id = $1, factory_run_id = $2, acquired_at = $3
             WHERE lease_key = $4`,
            [task_id, run.factory_run_id, nowIso(), ACTIVE_CODING_LEASE_KEY]
          );
        } else {
          await this._query(
            `INSERT INTO builder_leases(lease_key, owner, task_id, factory_run_id, acquired_at)
             VALUES ($1,$2,$3,$4,$5)`,
            [ACTIVE_CODING_LEASE_KEY, owner, task_id, run.factory_run_id, nowIso()]
          );
        }
        return { inserted: true, run };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const active = (await this.listActiveRuns())[0] || null;
        const taskRuns = await this.listRunsForTask(task_id);
        return {
          inserted: false,
          reason: 'UNIQUE_CONSTRAINT',
          run: active || taskRuns[taskRuns.length - 1] || null,
        };
      }
      throw err;
    }
  }
}

export async function openPostgresBuilderStore(databaseUrl, { schema = 'jarvis_builder' } = {}) {
  if (!databaseUrl) {
    throw new BuilderStoreConfigError(
      'JARVIS_BUILDER_DATABASE_URL is required',
      'MISSING_SHARED_BUILDER_DATABASE'
    );
  }
  const safeSchema = assertSafeSchemaName(schema);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 8,
    connectionTimeoutMillis: 8000,
    options: `-c search_path=${safeSchema},public`,
  });
    try {
      const client = await pool.connect();
      try {
        const sql = readFileSync(SCHEMA_PATH, 'utf8').replaceAll('jarvis_builder', safeSchema);
        await client.query(sql);
        await client.query(`SET search_path TO ${safeSchema}`);
      await client.query(
        `INSERT INTO builder_meta(key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        ['schema_version', SCHEMA_VERSION]
      );
    } finally {
      client.release();
    }
  } catch (err) {
    try { await pool.end(); } catch { /* ignore */ }
    const wrapped = new BuilderStoreConfigError(
      'shared Builder Postgres is unreachable',
      'SHARED_BUILDER_DATABASE_UNREACHABLE'
    );
    wrapped.cause = err;
    throw wrapped;
  }
  return new PostgresBuilderStore(pool, { schema: safeSchema, databaseUrl });
}
