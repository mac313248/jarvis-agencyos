// src/runtime/trusted-executor.js
// F-08 Trusted executor — deterministic idempotency + postcondition verify.
//
// Flow (07_AUTHORITY_SECURITY_EXECUTION.md#Trusted-executor-flow):
//   proposal → validate tenant/context → resolve capability → load grant/policy
//   → revalidate revocation+kill epochs immediately before commit
//   → commit → verify postcondition → append receipt
//
// NON-SCOPE: live external side effects; business-write autonomy remains DISABLED.
// Only local_fake adapters are accepted. Success is claimed ONLY when a receipt
// is appended with verification_status=VERIFIED. UNKNOWN/AMBIGUOUS never become
// SUCCEEDED. Authority/kill outages fail closed (DENY).

import { randomUUID } from 'node:crypto';
import { idempotencyKey } from '../contracts/ids.js';
import { loadProposal, loadApproval, validateApproval, loadOwnerSession } from '../contracts/approval.js';
import { resolveExecutableCapability } from '../contracts/capability-resolver.js';
import { loadActiveGrant } from '../contracts/grants.js';
import {
  readFreshAuthority,
  revalidateBeforeCommit,
  AuthorityUnavailableError,
} from '../contracts/authority.js';
import {
  assertBusinessWriteAutonomyDisabled,
  BUSINESS_WRITE_AUTONOMY,
} from './autonomy.js';
import { assertWritersAllowed, WritersFrozenError } from './dbos.js';
import { LOCAL_FAKE_SURFACE } from './local-effect-adapter.js';
import { createExecutionTrace } from './observability.js';
import { acquireLocalEffectScopeLock } from './reconciliation.js';
import {
  assertAutonomousRetryAllowedAfterAmbiguity,
  assertCrossSurfaceFallbackAllowed,
  EffectAmbiguityError,
} from './effect-ambiguity.js';
import {
  assertWorkflowMayCommitEffect,
  claimSemanticAction,
  releaseSemanticActionClaim,
  SingleFlightError,
} from './single-flight.js';
import { classifyAmbiguousOutcomePolicy } from '../contracts/capability.js';

export class TrustedExecutorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TrustedExecutorError';
    this.code = code;
    this.details = details;
  }
}

export class CrashAfterCommitError extends Error {
  constructor(payload) {
    super('injected crash after adapter commit before local completion');
    this.name = 'CrashAfterCommitError';
    this.payload = payload;
  }
}

function mapPostconditionToVerification(status) {
  if (status === 'VERIFIED') return 'VERIFIED';
  if (status === 'FAILED') return 'FAILED';
  if (status === 'UNVERIFIED') return 'UNVERIFIED';
  // UNKNOWN / AMBIGUOUS / ABSENT (unexpected after commit) → AMBIGUOUS
  return 'AMBIGUOUS';
}

function outcomeFromVerification(verificationStatus) {
  if (verificationStatus === 'VERIFIED') return 'SUCCEEDED';
  if (verificationStatus === 'FAILED') return 'FAILED';
  return 'AMBIGUOUS';
}

async function requireTenant(backend) {
  const r = await backend.query('SELECT cur_tenant() AS t;');
  const t = r.rows[0]?.t;
  if (!t) {
    throw new TrustedExecutorError('MISSING_TENANT_CONTEXT', 'missing tenant context (fail-closed)');
  }
  return t;
}

/**
 * Serialize effect-ledger pending/ambiguous creation/update with REPAIR
 * value-overwrite via the shared tenant local-effect scope xact lock.
 */
async function withLocalEffectScopeLock(backend, tenantId, fn) {
  await acquireLocalEffectScopeLock(backend, { tenantId });
  return fn();
}

function decidePolicy({ grant, capability, proposal }) {
  if (!grant) {
    return {
      verdict: 'DENY',
      reason_codes: ['NO_ACTIVE_GRANT'],
      policy_version: 'executor-v1',
    };
  }
  const ambiguity = classifyAmbiguousOutcomePolicy(capability);
  const approvalMode = grant.approval_mode || capability.approval_policy || 'default';
  const highRisk = proposal.risk_class === 'high' || proposal.risk_class === 't4'
    || approvalMode === 'owner_step_up' || approvalMode === 'approval_required'
    || ambiguity.min_verdict === 'APPROVAL_REQUIRED';
  if (highRisk) {
    return {
      verdict: 'APPROVAL_REQUIRED',
      reason_codes: ambiguity.min_verdict === 'APPROVAL_REQUIRED'
        ? ['HIGH_RISK_OR_APPROVAL_MODE', ...ambiguity.reason_codes]
        : ['HIGH_RISK_OR_APPROVAL_MODE'],
      policy_version: grant.policy_version || 'executor-v1',
    };
  }
  return {
    verdict: 'ALLOW',
    reason_codes: ['ACTIVE_GRANT'],
    policy_version: grant.policy_version || 'executor-v1',
  };
}

async function loadLedgerByKey(backend, key) {
  const r = await backend.query(
    `SELECT effect_id, tenant_id, idempotency_key, proposal_id, workflow_id, step_id,
            capability_id, request_hash, status, commit_token, postcondition_status,
            receipt_id, outcome, error_class, revocation_epoch_at_commit,
            kill_epoch_at_commit, started_at, committed_at, completed_at
     FROM effect_ledger WHERE idempotency_key = $1;`,
    [key]
  );
  return r.rows[0] ?? null;
}

async function appendReceipt(backend, fields) {
  const receiptId = fields.receipt_id || randomUUID();
  await backend.query(
    `INSERT INTO execution_receipts (
       receipt_id, tenant_id, workflow_id, step_id, actor, capability_id, provider,
       operation, target_ref, subject_ref, idempotency_key, request_hash,
       precondition_snapshot_ref, authority_decision_ref, approval_ref,
       revocation_epoch_at_commit, kill_epoch_at_commit, started_at, committed_at,
       provider_request_id, raw_evidence_ref, postcondition_verifier,
       verification_status, observed_external_version, state_delta_ref,
       error_class, retry_count, trace_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,
       $8,$9,$10,$11,$12,
       $13,$14,$15,
       $16,$17,$18,$19,
       $20,$21,$22,
       $23,$24,$25,
       $26,$27,$28
     );`,
    [
      receiptId,
      fields.tenant_id,
      fields.workflow_id,
      fields.step_id,
      fields.actor,
      fields.capability_id,
      fields.provider,
      fields.operation,
      fields.target_ref,
      fields.subject_ref ?? null,
      fields.idempotency_key,
      fields.request_hash,
      fields.precondition_snapshot_ref ?? null,
      fields.authority_decision_ref ?? null,
      fields.approval_ref ?? null,
      fields.revocation_epoch_at_commit,
      fields.kill_epoch_at_commit,
      fields.started_at,
      fields.committed_at,
      fields.provider_request_id ?? null,
      fields.raw_evidence_ref ?? null,
      fields.postcondition_verifier ?? null,
      fields.verification_status,
      fields.observed_external_version ?? null,
      fields.state_delta_ref ?? null,
      fields.error_class ?? null,
      fields.retry_count ?? 0,
      fields.trace_id,
    ]
  );
  return receiptId;
}

async function completeFromCommitted({
  backend,
  ledger,
  proposal,
  capability,
  adapter,
  authorityDecisionRef,
  approvalRef,
  forcedPostcondition,
  startedAt,
}) {
  const post = await adapter.verifyPostcondition({
    idempotency_key: ledger.idempotency_key,
    forcedStatus: forcedPostcondition,
  });
  const verificationStatus = mapPostconditionToVerification(post.status);
  const outcome = outcomeFromVerification(verificationStatus);

  // Never claim SUCCEEDED without VERIFIED receipt.
  if (outcome === 'SUCCEEDED' && verificationStatus !== 'VERIFIED') {
    throw new TrustedExecutorError(
      'UNVERIFIED_SUCCESS_FORBIDDEN',
      'success claimed without VERIFIED receipt (fail-closed)'
    );
  }

  // F-12: receipts must bind to a real execution_traces row (no dangling UUIDs).
  const trace = await createExecutionTrace(backend, {
    tenant_id: proposal.tenant_id,
    workflow_id: proposal.workflow_id,
    root_span: 'trusted_executor',
    attributes: {
      step_id: proposal.step_id,
      capability_id: proposal.capability_id,
      effect_id: ledger.effect_id,
    },
  });

  const receiptId = await appendReceipt(backend, {
    tenant_id: proposal.tenant_id,
    workflow_id: proposal.workflow_id,
    step_id: proposal.step_id,
    actor: proposal.actor,
    capability_id: proposal.capability_id,
    provider: capability.provider,
    operation: capability.operation,
    target_ref: proposal.target_ref,
    idempotency_key: ledger.idempotency_key,
    request_hash: proposal.request_hash,
    precondition_snapshot_ref: proposal.precondition_snapshot_ref,
    authority_decision_ref: authorityDecisionRef,
    approval_ref: approvalRef,
    revocation_epoch_at_commit: ledger.revocation_epoch_at_commit,
    kill_epoch_at_commit: ledger.kill_epoch_at_commit,
    started_at: startedAt || ledger.started_at,
    committed_at: ledger.committed_at,
    provider_request_id: ledger.commit_token,
    postcondition_verifier: capability.postcondition_verifier,
    verification_status: verificationStatus,
    error_class: outcome === 'SUCCEEDED' ? null : `postcondition_${post.status.toLowerCase()}`,
    trace_id: trace.trace_id,
  });

  // Completion may land AMBIGUOUS/UNKNOWN/UNVERIFIED — same scope lock as REPAIR.
  await withLocalEffectScopeLock(backend, proposal.tenant_id, async () => {
    await backend.query(
      `UPDATE effect_ledger
       SET status = 'COMPLETED',
           postcondition_status = $2,
           receipt_id = $3,
           outcome = $4,
           completed_at = now(),
           error_class = $5
       WHERE effect_id = $1;`,
      [
        ledger.effect_id,
        post.status === 'ABSENT' ? 'UNKNOWN' : post.status,
        receiptId,
        outcome,
        outcome === 'SUCCEEDED' ? null : `postcondition_${String(post.status).toLowerCase()}`,
      ]
    );
  });

  return {
    status: outcome,
    verification_status: verificationStatus,
    postcondition_status: post.status,
    receipt_id: receiptId,
    effect_id: ledger.effect_id,
    idempotency_key: ledger.idempotency_key,
    commit_token: ledger.commit_token,
    resumed: true,
    claimed_success: outcome === 'SUCCEEDED',
  };
}

/**
 * Execute a trusted proposal against a local_fake adapter.
 *
 * @param {object} backend - tenant-scoped runtime transaction/connection
 * @param {object} args
 * @param {string} args.proposal_id
 * @param {string} args.principal
 * @param {object} args.adapter - must have surface === 'local_fake'
 * @param {string} [args.approval_id]
 * @param {string} [args.owner_session_id]
 * @param {'after_commit'|null} [args.injectCrash]
 * @param {'VERIFIED'|'AMBIGUOUS'|'UNKNOWN'|'FAILED'|'ABSENT'|null} [args.forcedPostcondition]
 */
export async function executeTrustedEffect(backend, args) {
  assertBusinessWriteAutonomyDisabled();
  if (BUSINESS_WRITE_AUTONOMY !== false) {
    throw new TrustedExecutorError('BUSINESS_WRITE_AUTONOMY_ENABLED', 'business-write autonomy must remain DISABLED');
  }

  // F-09 restore/#52: material writers stay frozen until reconciliation completes.
  try {
    await assertWritersAllowed(backend);
  } catch (err) {
    if (err instanceof WritersFrozenError) {
      throw new TrustedExecutorError('WRITERS_FROZEN', err.message);
    }
    throw err;
  }

  const adapter = args?.adapter;
  if (!adapter || adapter.surface !== LOCAL_FAKE_SURFACE) {
    throw new TrustedExecutorError(
      'LIVE_EXTERNAL_FORBIDDEN',
      'only local_fake adapters are permitted in F-08 (no live external side effects)'
    );
  }

  const tenantId = await requireTenant(backend);
  const proposal = await loadProposal(backend, args.proposal_id);
  if (!proposal) {
    throw new TrustedExecutorError('PROPOSAL_NOT_FOUND', `proposal ${args.proposal_id} not found`);
  }
  if (proposal.tenant_id !== tenantId) {
    throw new TrustedExecutorError('TENANT_MISMATCH', 'proposal tenant does not match trusted context');
  }

  const resolution = await resolveExecutableCapability(backend, proposal.capability_id);
  const capability = resolution.capability;

  const grant = await loadActiveGrant(backend, {
    principal: args.principal,
    capability_id: proposal.capability_id,
  });
  const policy = decidePolicy({ grant, capability, proposal });

  const policyDecisionId = randomUUID();
  let authority;
  try {
    authority = await readFreshAuthority(backend);
  } catch (err) {
    if (err instanceof AuthorityUnavailableError) {
      // Fail closed on authority/kill outage — never fail open.
      await backend.query(
        `INSERT INTO policy_decisions (
           decision_id, tenant_id, proposal_id, applicable_grants, policy_version,
           verdict, reason_codes, effective_caps, revocation_epoch_checked,
           kill_epoch_checked, decided_at
         ) VALUES ($1,$2,$3,'[]'::jsonb,$4,'DENY',$5::jsonb,'{}'::jsonb, -1, -1, now());`,
        [
          policyDecisionId,
          tenantId,
          proposal.proposal_id,
          policy.policy_version,
          JSON.stringify(['AUTHORITY_KILL_STORE_UNAVAILABLE']),
        ]
      );
      return {
        status: 'DENIED',
        verification_status: null,
        reason_codes: ['AUTHORITY_KILL_STORE_UNAVAILABLE'],
        claimed_success: false,
        idempotency_key: null,
      };
    }
    throw err;
  }

  await backend.query(
    `INSERT INTO policy_decisions (
       decision_id, tenant_id, proposal_id, applicable_grants, policy_version,
       verdict, reason_codes, effective_caps, revocation_epoch_checked,
       kill_epoch_checked, decided_at
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,'{}'::jsonb,$8,$9, now());`,
    [
      policyDecisionId,
      tenantId,
      proposal.proposal_id,
      JSON.stringify(grant ? [grant.grant_id] : []),
      policy.policy_version,
      policy.verdict,
      JSON.stringify(policy.reason_codes),
      authority.revocationEpoch,
      authority.killEpoch,
    ]
  );

  if (policy.verdict === 'DENY') {
    return {
      status: 'DENIED',
      verification_status: null,
      reason_codes: policy.reason_codes,
      claimed_success: false,
      policy_decision_id: policyDecisionId,
      idempotency_key: null,
    };
  }

  let approvalRef = null;
  if (policy.verdict === 'APPROVAL_REQUIRED') {
    if (!args.approval_id) {
      return {
        status: 'DENIED',
        verification_status: null,
        reason_codes: ['APPROVAL_REQUIRED'],
        claimed_success: false,
        policy_decision_id: policyDecisionId,
        idempotency_key: null,
      };
    }
    const approval = await loadApproval(backend, args.approval_id);
    const session = args.owner_session_id
      ? await loadOwnerSession(backend, args.owner_session_id)
      : null;
    const v = validateApproval({ approval, proposal, session });
    if (!v.valid) {
      return {
        status: 'DENIED',
        verification_status: null,
        reason_codes: ['INVALID_APPROVAL', ...v.reasons],
        claimed_success: false,
        policy_decision_id: policyDecisionId,
        idempotency_key: null,
      };
    }
    approvalRef = approval.approval_id;
  }

  const key = idempotencyKey({
    tenant_id: proposal.tenant_id,
    workflow_id: proposal.workflow_id,
    step_id: proposal.step_id,
    capability_id: proposal.capability_id,
    request_hash: proposal.request_hash,
  });

  // V1.0C #28: autonomous retry after AMBIGUOUS/UNKNOWN requires policy allow.
  // Also auto-engage when durable prior ledger for this exact key is ambiguous
  // and the capability forbids autonomous retry (fail closed without caller flag).
  {
    const prior = await loadLedgerByKey(backend, key);
    const priorOutcome = prior?.outcome ?? args.prior_outcome ?? null;
    const priorPost = prior?.postcondition_status ?? args.prior_postcondition ?? null;
    const ambiguousPrior =
      priorOutcome === 'AMBIGUOUS' ||
      priorPost === 'AMBIGUOUS' ||
      priorPost === 'UNKNOWN' ||
      priorPost === 'UNVERIFIED';
    if (args.retry_after_ambiguity || (ambiguousPrior && prior?.status === 'COMPLETED')) {
      try {
        assertAutonomousRetryAllowedAfterAmbiguity(capability, {
          prior_outcome: priorOutcome,
          prior_postcondition: priorPost,
        });
      } catch (err) {
        if (err instanceof EffectAmbiguityError) {
          return {
            status: 'DENIED',
            verification_status: null,
            reason_codes: [err.code, ...(err.details?.reason_codes || [])],
            claimed_success: false,
            idempotency_key: key,
            policy_decision_id: policyDecisionId,
          };
        }
        throw err;
      }
    }
  }

  // V1.0C #29: browser/Orgo fallback only after durable VERIFIED ABSENT evidence.
  if (args.fallback_surface) {
    try {
      let postStatus = args.prior_postcondition ?? null;
      let durable = false;
      if (args.prior_idempotency_key) {
        const priorLedger = await loadLedgerByKey(backend, args.prior_idempotency_key);
        if (priorLedger?.postcondition_status) {
          postStatus = priorLedger.postcondition_status;
          durable = true;
        }
      }
      if (args.durable_postcondition_evidence === true && postStatus) {
        durable = true;
      }
      assertCrossSurfaceFallbackAllowed({
        prior_surface: args.prior_surface || capability.control_surface || 'api',
        fallback_surface: args.fallback_surface,
        postcondition_status: postStatus,
        durable_evidence: durable,
      });
    } catch (err) {
      if (err instanceof EffectAmbiguityError) {
        return {
          status: 'DENIED',
          verification_status: null,
          reason_codes: [err.code],
          claimed_success: false,
          idempotency_key: key,
          policy_decision_id: policyDecisionId,
        };
      }
      throw err;
    }
  }

  // V1.0C #33: cancelled/expired/missing single-flight workflows cannot commit late.
  if (args.enforce_single_flight) {
    try {
      await assertWorkflowMayCommitEffect(backend, {
        workflow_id: proposal.workflow_id,
        subject_ref: args.subject_ref ?? null,
        routine_id: args.routine_id ?? null,
        logical_stage: args.logical_stage ?? null,
        requireActiveFlight: true,
      });
    } catch (err) {
      if (err instanceof SingleFlightError) {
        return {
          status: 'DENIED',
          verification_status: null,
          reason_codes: [err.code],
          claimed_success: false,
          idempotency_key: key,
          policy_decision_id: policyDecisionId,
        };
      }
      throw err;
    }
  }

  // V1.0C #34: provisional semantic claim; released if commit does not succeed.
  let semanticClaimHeld = false;
  if (args.semantic_action_key && args.subject_ref) {
    try {
      await claimSemanticAction(backend, {
        subject_ref: args.subject_ref,
        semantic_action_key: args.semantic_action_key,
        workflow_id: proposal.workflow_id,
        effect_id: null,
      });
      semanticClaimHeld = true;
    } catch (err) {
      if (err instanceof SingleFlightError) {
        return {
          status: 'DENIED',
          verification_status: null,
          reason_codes: [err.code],
          claimed_success: false,
          idempotency_key: key,
          policy_decision_id: policyDecisionId,
        };
      }
      throw err;
    }
  }

  async function releaseSemanticIfNeeded() {
    if (!semanticClaimHeld) return;
    await releaseSemanticActionClaim(backend, {
      subject_ref: args.subject_ref,
      semantic_action_key: args.semantic_action_key,
      workflow_id: proposal.workflow_id,
    });
    semanticClaimHeld = false;
  }

  // At-most-once: completed ledger/receipt short-circuits.
  let ledger = await loadLedgerByKey(backend, key);
  if (ledger?.status === 'COMPLETED') {
    if (ledger.outcome !== 'SUCCEEDED') await releaseSemanticIfNeeded();
    return {
      status: ledger.outcome,
      verification_status: ledger.postcondition_status === 'VERIFIED' ? 'VERIFIED' : mapPostconditionToVerification(ledger.postcondition_status),
      receipt_id: ledger.receipt_id,
      effect_id: ledger.effect_id,
      idempotency_key: key,
      commit_token: ledger.commit_token,
      duplicate: true,
      claimed_success: ledger.outcome === 'SUCCEEDED',
      policy_decision_id: policyDecisionId,
    };
  }

  // Crash recovery: adapter already committed and/or ledger COMMITTED → do not re-commit.
  if (ledger?.status === 'COMMITTED' || adapter.hasCommitted(key)) {
    if (!ledger) {
      // Adapter committed but local ledger missing — recreate COMMITTED row.
      const existing = adapter.getCommitted(key);
      const effectId = randomUUID();
      await withLocalEffectScopeLock(backend, tenantId, async () => {
        await backend.query(
          `INSERT INTO effect_ledger (
             effect_id, tenant_id, idempotency_key, proposal_id, workflow_id, step_id,
             capability_id, request_hash, status, commit_token,
             revocation_epoch_at_commit, kill_epoch_at_commit, committed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'COMMITTED',$9,$10,$11, now());`,
          [
            effectId,
            tenantId,
            key,
            proposal.proposal_id,
            proposal.workflow_id,
            proposal.step_id,
            proposal.capability_id,
            proposal.request_hash,
            existing.commit_token,
            authority.revocationEpoch,
            authority.killEpoch,
          ]
        );
      });
      ledger = await loadLedgerByKey(backend, key);
    } else if (ledger.status !== 'COMMITTED') {
      await withLocalEffectScopeLock(backend, tenantId, async () => {
        await backend.query(
          `UPDATE effect_ledger
           SET status = 'COMMITTED',
               commit_token = COALESCE(commit_token, $2),
               committed_at = COALESCE(committed_at, now()),
               revocation_epoch_at_commit = COALESCE(revocation_epoch_at_commit, $3),
               kill_epoch_at_commit = COALESCE(kill_epoch_at_commit, $4)
           WHERE effect_id = $1;`,
          [
            ledger.effect_id,
            adapter.getCommitted(key)?.commit_token ?? null,
            authority.revocationEpoch,
            authority.killEpoch,
          ]
        );
      });
      ledger = await loadLedgerByKey(backend, key);
    }

    const resumed = await completeFromCommitted({
      backend,
      ledger,
      proposal,
      capability,
      adapter,
      authorityDecisionRef: policyDecisionId,
      approvalRef,
      forcedPostcondition: args.forcedPostcondition ?? null,
      startedAt: ledger.started_at,
    });
    if (!resumed.claimed_success) await releaseSemanticIfNeeded();
    return { ...resumed, policy_decision_id: policyDecisionId, duplicate: true };
  }

  // Fresh path: revalidate revocation + kill epochs immediately before commit.
  let revalidation;
  try {
    revalidation = await revalidateBeforeCommit(
      backend,
      authority.revocationEpoch,
      authority.killEpoch
    );
  } catch (err) {
    if (err instanceof AuthorityUnavailableError) {
      await releaseSemanticIfNeeded();
      return {
        status: 'DENIED',
        verification_status: null,
        reason_codes: ['AUTHORITY_KILL_STORE_UNAVAILABLE_AT_COMMIT'],
        claimed_success: false,
        idempotency_key: key,
        policy_decision_id: policyDecisionId,
      };
    }
    throw err;
  }

  if (!revalidation.decision.allowed) {
    await releaseSemanticIfNeeded();
    return {
      status: 'DENIED',
      verification_status: null,
      reason_codes: revalidation.decision.reasons,
      claimed_success: false,
      idempotency_key: key,
      policy_decision_id: policyDecisionId,
    };
  }

  const effectId = randomUUID();
  const startedAt = new Date().toISOString();
  // PENDING insert is mutually exclusive with REPAIR overwrite for this tenant.
  await withLocalEffectScopeLock(backend, tenantId, async () => {
    await backend.query(
      `INSERT INTO effect_ledger (
         effect_id, tenant_id, idempotency_key, proposal_id, workflow_id, step_id,
         capability_id, request_hash, status, started_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9)
       ON CONFLICT (idempotency_key) DO NOTHING;`,
      [
        effectId,
        tenantId,
        key,
        proposal.proposal_id,
        proposal.workflow_id,
        proposal.step_id,
        proposal.capability_id,
        proposal.request_hash,
        startedAt,
      ]
    );
  });

  // Race: another worker may have inserted first.
  ledger = await loadLedgerByKey(backend, key);
  if (!ledger) {
    throw new TrustedExecutorError('LEDGER_INSERT_FAILED', 'effect ledger row missing after insert');
  }
  if (ledger.status === 'COMPLETED') {
    return {
      status: ledger.outcome,
      verification_status: ledger.postcondition_status === 'VERIFIED' ? 'VERIFIED' : mapPostconditionToVerification(ledger.postcondition_status),
      receipt_id: ledger.receipt_id,
      effect_id: ledger.effect_id,
      idempotency_key: key,
      duplicate: true,
      claimed_success: ledger.outcome === 'SUCCEEDED',
      policy_decision_id: policyDecisionId,
    };
  }
  if (ledger.effect_id !== effectId && (ledger.status === 'COMMITTED' || adapter.hasCommitted(key))) {
    const resumed = await completeFromCommitted({
      backend,
      ledger,
      proposal,
      capability,
      adapter,
      authorityDecisionRef: policyDecisionId,
      approvalRef,
      forcedPostcondition: args.forcedPostcondition ?? null,
      startedAt: ledger.started_at,
    });
    if (!resumed.claimed_success) await releaseSemanticIfNeeded();
    return { ...resumed, policy_decision_id: policyDecisionId, duplicate: true };
  }

  // Commit through local_fake adapter (idempotent).
  const commitResult = await adapter.commit({
    idempotency_key: key,
    request: proposal.canonical_request,
  });

  await withLocalEffectScopeLock(backend, tenantId, async () => {
    await backend.query(
      `UPDATE effect_ledger
       SET status = 'COMMITTED',
           commit_token = $2,
           committed_at = now(),
           revocation_epoch_at_commit = $3,
           kill_epoch_at_commit = $4
       WHERE effect_id = $1;`,
      [
        ledger.effect_id,
        commitResult.commit_token,
        revalidation.fresh.revocationEpoch,
        revalidation.fresh.killEpoch,
      ]
    );
  });
  ledger = await loadLedgerByKey(backend, key);

  if (args.injectCrash === 'after_commit') {
    throw new CrashAfterCommitError({
      effect_id: ledger.effect_id,
      idempotency_key: key,
      commit_token: commitResult.commit_token,
    });
  }

  const finished = await completeFromCommitted({
    backend,
    ledger,
    proposal,
    capability,
    adapter,
    authorityDecisionRef: policyDecisionId,
    approvalRef,
    forcedPostcondition: args.forcedPostcondition ?? null,
    startedAt,
  });

  if (!finished.claimed_success) await releaseSemanticIfNeeded();

  return {
    ...finished,
    resumed: false,
    duplicate: commitResult.already_present === true,
    policy_decision_id: policyDecisionId,
  };
}

/** Pure helper exposed for #21 stability assertions through the executor module. */
export function computeEffectIdempotencyKey(parts) {
  return idempotencyKey(parts);
}
