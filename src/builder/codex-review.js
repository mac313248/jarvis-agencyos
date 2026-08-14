// Independent Codex semantic review for Builder Stage 1.
// Deterministic verifier runs first. Codex is review evidence only:
// never task truth, never writer, never merger, never DONE authority.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  CANDIDATE_STATUS,
  EVENT_TYPE,
  REVIEW_STATUS,
  TASK_STATUS,
  VERIFICATION_RESULT,
  assertCommitSha,
  newId,
} from './contracts.js';
import { BuilderCoreError } from './errors.js';
import { VerifierError, isVerificationAuthoritative } from './verifier.js';
import { co, settle } from './thenable.js';

const DEFAULT_SCHEMA = 'scripts/builder-codex-review.schema.json';
const DEFAULT_CODEX_BIN = 'codex';
/** Primary review model (matches local Codex config when present). */
export const DEFAULT_CODEX_REVIEW_MODEL = 'gpt-5.6-luna';
/** Single already-supported alternate used only on capacity/unavailable-model. */
export const DEFAULT_CODEX_FALLBACK_MODEL = 'gpt-5.4';

export class CodexReviewError extends Error {
  constructor(message, code = 'CODEX_REVIEW_ERROR') {
    super(message);
    this.name = 'CodexReviewError';
    this.code = code;
  }
}

/** Capacity / unavailable-model only — never auth, policy, or REQUEST_CHANGES. */
export function isCodexModelCapacityOrUnavailable(raw) {
  const text = String(raw || '');
  if (
    /unauthorized|authentication|auth failed|invalid api key|login required|forbidden|policy|permission denied|not logged in/i.test(
      text
    )
  ) {
    return false;
  }
  return /at capacity|selected model is at capacity|model .* unavailable|unavailable model|unknown model|model_not_found|model not found|try a different model/i.test(
    text
  );
}

function nowIso() {
  return new Date().toISOString();
}

export function buildCodexReviewPrompt({
  task,
  candidate,
  verification,
  diff,
}) {
  return [
    'You are the independent READ-ONLY Codex reviewer for JARVIS Builder Stage 1.',
    'ROLE LIMITS (hard):',
    '- Do NOT modify code, tests, acceptance criteria, or git state.',
    '- Do NOT approve, merge, or mark the task DONE.',
    '- Do NOT treat the implementation worker self-report as evidence.',
    '- Review only. Output JSON matching the provided schema.',
    '',
    `candidate_id: ${candidate.candidate_id}`,
    `commit_sha: ${candidate.commit_sha}`,
    `task_id: ${task.task_id}`,
    `locked_intent: ${task.intent}`,
    `locked_acceptance_ref: ${task.acceptance_ref}`,
    `allowed_paths: ${JSON.stringify(task.allowed_paths)}`,
    `deterministic_verification_result: ${verification.result}`,
    `deterministic_verification_id: ${verification.verification_id}`,
    'deterministic_checks:',
    JSON.stringify(verification.checks || [], null, 2),
    '',
    'CANDIDATE DIFF (exact SHA; truncated if large):',
    diff || '(no diff provided)',
    '',
    'EVIDENCE RULES:',
    '- The supplied CANDIDATE DIFF is authoritative for this exact commit_sha.',
    '- Do NOT require the commit to exist in the local git checkout.',
    '- Do NOT emit intermediate schema JSON. Emit the schema JSON once as the final answer only.',
    '- Prefer the supplied diff + deterministic_checks over exploratory shell commands.',
    '',
    'Return ONLY JSON: {"review_status":"PASS|REQUEST_CHANGES|BLOCKED","findings":[]}.',
    'Use REQUEST_CHANGES for material defects; BLOCKED if you cannot complete a safe review.',
  ].join('\n');
}

export function parseCodexReviewOutput(output) {
  if (typeof output !== 'string') {
    return { ok: false, code: 'EMPTY_OUTPUT' };
  }
  const candidates = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event?.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        candidates.push(event.item.text);
      }
      if (typeof event?.result === 'string') candidates.push(event.result);
      if (event && !event.type && !event.item && !event.result) candidates.push(line);
    } catch {
      // ignore non-json lines
    }
  }
  candidates.push(output.trim());
  for (const candidate of candidates.reverse()) {
    let value;
    try {
      value = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!Object.values(REVIEW_STATUS).includes(value.review_status)) continue;
    if (!Array.isArray(value.findings) || value.findings.some((f) => typeof f !== 'string')) {
      continue;
    }
    return {
      ok: true,
      review_status: value.review_status,
      findings: value.findings,
    };
  }
  return { ok: false, code: 'REVIEW_PROTOCOL_ERROR' };
}

export function createCodexReviewInvoker({
  repoRoot = process.cwd(),
  codexBin = DEFAULT_CODEX_BIN,
  schemaPath = join(repoRoot, DEFAULT_SCHEMA),
  execFileSyncFn = execFileSync,
  timeoutMs = 10 * 60 * 1000,
  model = DEFAULT_CODEX_REVIEW_MODEL,
  fallbackModel = DEFAULT_CODEX_FALLBACK_MODEL,
} = {}) {
  function extractInvokerErrorMessage(raw) {
    const lines = String(raw || '').split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const ev = JSON.parse(lines[i]);
        if (ev?.type === 'error' && ev.message) return String(ev.message).slice(0, 400);
        if (ev?.type === 'turn.failed' && ev.error?.message) {
          return String(ev.error.message).slice(0, 400);
        }
      } catch {
        // keep scanning
      }
    }
    const last = lines.at(-1) || 'codex failed';
    return last.slice(0, 400);
  }

  function runOnce(prompt, modelId) {
    const args = [
      '-a',
      'never',
      'exec',
      '-C',
      repoRoot,
      '-s',
      'read-only',
      '--ephemeral',
      '--json',
      '--output-schema',
      schemaPath,
    ];
    if (modelId) {
      args.push('-m', modelId);
    }
    // Prompt last; never put credentials in argv beyond model id.
    args.push(prompt);
    try {
      // Global -a never before exec; sandbox read-only; ephemeral; schema-bound.
      const out = execFileSyncFn(codexBin, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        env: process.env,
      });
      return { ok: true, raw: out, model: modelId || null };
    } catch (err) {
      const raw = String(err?.stdout || err?.stderr || err?.message || err);
      const timedOut = /ETIMEDOUT|timed out/i.test(
        String(err?.code || err?.message || '')
      );
      // If Codex emitted a final schema-valid review before non-zero exit, accept it.
      // Ignore early intermediate schema-shaped chatter by requiring turn completion
      // or a trailing agent_message after the last turn.started.
      const parsed = parseCodexReviewOutput(raw);
      const completed =
        /"type"\s*:\s*"turn\.completed"/i.test(raw) ||
        /"type"\s*:\s*"turn\.failed"/i.test(raw);
      if (parsed.ok && completed && !/"type"\s*:\s*"turn\.failed"/i.test(raw)) {
        return { ok: true, raw, model: modelId || null, recovered_from_nonzero_exit: true };
      }
      return {
        ok: false,
        raw,
        model: modelId || null,
        error: {
          name: err?.name || 'Error',
          message: extractInvokerErrorMessage(raw),
          code: timedOut ? 'TIMEOUT' : 'CODEX_INVOKE_FAILED',
          retryable: false,
        },
      };
    }
  }

  return {
    mode: 'read-only',
    primary_model: model || null,
    fallback_model: fallbackModel || null,
    async review({ prompt }) {
      const primary = runOnce(prompt, model);
      if (primary.ok) {
        return {
          ...primary,
          primary_model: model || null,
          fallback_model: null,
          fallback_used: false,
          attempts: 1,
        };
      }
      // Exactly one fallback, and only for capacity / unavailable-model.
      if (
        fallbackModel &&
        fallbackModel !== model &&
        isCodexModelCapacityOrUnavailable(primary.raw || primary.error?.message)
      ) {
        const second = runOnce(prompt, fallbackModel);
        return {
          ...second,
          primary_model: model || null,
          fallback_model: fallbackModel,
          fallback_used: true,
          primary_error: primary.error || null,
          attempts: 2,
        };
      }
      return {
        ...primary,
        primary_model: model || null,
        fallback_model: null,
        fallback_used: false,
        attempts: 1,
      };
    },
  };
}

export async function reviewExactCandidate({
  core,
  candidate_id,
  invoker,
  getDiff = async () => '',
  // Optional: pass already-computed verification; otherwise require stored PASS.
  verification = null,
}) {
  const candidate = await settle(core.store.getCandidate(candidate_id));
  if (!candidate) {
    throw new CodexReviewError(`unknown candidate_id: ${candidate_id}`, 'UNKNOWN_CANDIDATE');
  }
  const task = await settle(core.store.getTask(candidate.task_id));
  if (!task) {
    throw new CodexReviewError(`unknown task_id: ${candidate.task_id}`, 'UNKNOWN_TASK');
  }

  const run = await settle(core.store.getRun(candidate.factory_run_id));
  if (!run) {
    throw new CodexReviewError('candidate factory_run_id missing', 'MISSING_RUN');
  }
  if (run.status === 'STALE' || run.status === 'CANCELLED') {
    await settle(core.store.appendEvent({
      task_id: task.task_id,
      factory_run_id: run.factory_run_id,
      event_type: EVENT_TYPE.STALE_RUN_REJECTED,
      payload: {
        reason: 'review_from_cancelled_or_stale_run',
        status: run.status,
        candidate_id,
      },
    }));
    throw new BuilderCoreError(
      `cancelled/stale run cannot authorize review: ${run.factory_run_id}`,
      'STALE_RUN'
    );
  }

  const sha = assertCommitSha(candidate.commit_sha);
  // Caller-supplied verification objects are never authoritative. Always bind to
  // the candidate's current stored verification_ref and require live authority.
  if (verification != null) {
    const presentedId = verification.verification_id;
    if (!presentedId || presentedId !== candidate.verification_ref) {
      throw new VerifierError(
        'Codex review requires the candidate current stored verification_ref',
        'VERIFIER_REQUIRED_FIRST'
      );
    }
  }
  const ver = candidate.verification_ref
    ? await settle(core.store.getVerification(candidate.verification_ref))
    : null;
  if (!ver || !(await settle(isVerificationAuthoritative(core, ver.verification_id)))) {
    throw new VerifierError(
      'Codex review requires prior deterministic PASS on the exact candidate',
      'VERIFIER_REQUIRED_FIRST'
    );
  }
  if (ver.commit_sha !== sha || ver.candidate_id !== candidate_id) {
    throw new CodexReviewError(
      'verification is not bound to this candidate/SHA',
      'SHA_MISMATCH'
    );
  }

  // review_required=false: skip Codex, return bypass evidence (verifier still mandatory above).
  if (!task.review_required) {
    const bypass = await settle(core.store.insertReview({
      review_id: newId('rev'),
      candidate_id,
      commit_sha: sha,
      review_status: REVIEW_STATUS.PASS,
      findings: ['review_required=false; Codex bypassed; deterministic verifier remains mandatory'],
      evidence: {
        bypassed: true,
        reason: 'review_required_false',
        verification_id: ver.verification_id,
      },
      reviewed_at: nowIso(),
    }));
    await settle(core.store.updateCandidate(candidate_id, { review_ref: bypass.review_id }));
    await settle(core.store.appendEvent({
      task_id: task.task_id,
      factory_run_id: candidate.factory_run_id,
      event_type: EVENT_TYPE.REVIEW_BYPASSED,
      payload: {
        review_id: bypass.review_id,
        candidate_id,
        commit_sha: sha,
      },
    }));
    return {
      review: bypass,
      gate: evaluateReviewGate({ task, verification: ver, review: bypass }),
    };
  }

  if (!invoker || typeof invoker.review !== 'function') {
    const blocked = await settle(core.store.insertReview({
      review_id: newId('rev'),
      candidate_id,
      commit_sha: sha,
      review_status: REVIEW_STATUS.BLOCKED,
      findings: ['Codex invoker unavailable'],
      evidence: { error: { code: 'INVOKER_MISSING' } },
      reviewed_at: nowIso(),
    }));
    await settle(core.store.updateCandidate(candidate_id, { review_ref: blocked.review_id }));
    return {
      review: blocked,
      gate: evaluateReviewGate({ task, verification: ver, review: blocked }),
    };
  }

  const diff = await getDiff({
    commit_sha: sha,
    candidate,
    task,
  });
  const prompt = buildCodexReviewPrompt({
    task,
    candidate,
    verification: ver,
    diff: String(diff || '').slice(0, 120000),
  });

  const invoked = await invoker.review({ prompt, candidate, task, verification: ver });
  const modelEvidence = {
    primary_model: invoked?.primary_model ?? invoker.primary_model ?? null,
    fallback_model: invoked?.fallback_used
      ? invoked?.fallback_model ?? invoker.fallback_model ?? null
      : null,
    fallback_used: Boolean(invoked?.fallback_used),
    model_used: invoked?.model ?? null,
    attempts: invoked?.attempts ?? 1,
  };
  if (!invoked?.ok) {
    const blocked = await settle(core.store.insertReview({
      review_id: newId('rev'),
      candidate_id,
      commit_sha: sha,
      review_status: REVIEW_STATUS.BLOCKED,
      findings: [
        `Codex unavailable/error/timeout: ${invoked?.error?.message || 'unknown'}`,
      ],
      evidence: {
        error: invoked?.error || { code: 'CODEX_UNAVAILABLE' },
        raw_excerpt: String(invoked?.raw || '').slice(0, 8000),
        ...modelEvidence,
      },
      reviewed_at: nowIso(),
    }));
    await settle(core.store.updateCandidate(candidate_id, { review_ref: blocked.review_id }));
    await settle(core.store.appendEvent({
      task_id: task.task_id,
      factory_run_id: candidate.factory_run_id,
      event_type: EVENT_TYPE.REVIEW_RECORDED,
      payload: {
        review_id: blocked.review_id,
        candidate_id,
        commit_sha: sha,
        review_status: REVIEW_STATUS.BLOCKED,
      },
    }));
    if (task.status !== TASK_STATUS.BLOCKED) {
      await settle(core.updateTaskStatus(task.task_id, TASK_STATUS.BLOCKED));
    }
    return {
      review: blocked,
      gate: evaluateReviewGate({
        task: await settle(core.getTask(task.task_id)),
        verification: ver,
        review: blocked,
      }),
    };
  }

  const parsed = parseCodexReviewOutput(invoked.raw);
  if (!parsed.ok) {
    const blocked = await settle(core.store.insertReview({
      review_id: newId('rev'),
      candidate_id,
      commit_sha: sha,
      review_status: REVIEW_STATUS.BLOCKED,
      findings: [`Codex review protocol error: ${parsed.code}`],
      evidence: {
        error: { code: parsed.code },
        raw_excerpt: String(invoked.raw || '').slice(0, 2000),
        ...modelEvidence,
      },
      reviewed_at: nowIso(),
    }));
    await settle(core.store.updateCandidate(candidate_id, { review_ref: blocked.review_id }));
    if (task.status !== TASK_STATUS.BLOCKED) {
      await settle(core.updateTaskStatus(task.task_id, TASK_STATUS.BLOCKED));
    }
    return {
      review: blocked,
      gate: evaluateReviewGate({
        task: await settle(core.getTask(task.task_id)),
        verification: ver,
        review: blocked,
      }),
    };
  }

  const review = await settle(core.store.insertReview({
    review_id: newId('rev'),
    candidate_id,
    commit_sha: sha,
    review_status: parsed.review_status,
    findings: parsed.findings,
    evidence: {
      verification_id: ver.verification_id,
      invoker_mode: invoker.mode || 'read-only',
      raw_excerpt: String(invoked.raw || '').slice(0, 2000),
      ...modelEvidence,
    },
    reviewed_at: nowIso(),
  }));
  await settle(core.store.updateCandidate(candidate_id, { review_ref: review.review_id }));
  await settle(core.store.appendEvent({
    task_id: task.task_id,
    factory_run_id: candidate.factory_run_id,
    event_type: EVENT_TYPE.REVIEW_RECORDED,
    payload: {
      review_id: review.review_id,
      candidate_id,
      commit_sha: sha,
      review_status: review.review_status,
    },
  }));

  const gate = evaluateReviewGate({
    task: await settle(core.getTask(task.task_id)),
    verification: ver,
    review,
  });
  if (!gate.ok && parsed.review_status === REVIEW_STATUS.REQUEST_CHANGES) {
    await settle(core.store.updateCandidate(candidate_id, {
      status: CANDIDATE_STATUS.REJECTED,
    }));
  }
  return { review, gate };
}

export function evaluateReviewGate({ task, verification, review }) {
  if (!verification || verification.invalidated_at) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: 'deterministic_verification_missing_or_invalid',
    };
  }
  if (verification.result !== VERIFICATION_RESULT.PASS) {
    return {
      ok: false,
      status: verification.result === VERIFICATION_RESULT.FAIL ? 'FAIL' : 'BLOCKED',
      reason: 'deterministic_verification_not_pass',
    };
  }
  if (!task.review_required) {
    return {
      ok: true,
      status: 'PASS',
      reason: 'review_required_false_verifier_pass',
      review_bypassed: true,
    };
  }
  if (!review) {
    return { ok: false, status: 'BLOCKED', reason: 'review_required_missing' };
  }
  if (review.invalidated_at) {
    return { ok: false, status: 'BLOCKED', reason: 'review_invalidated' };
  }
  if (review.commit_sha !== verification.commit_sha) {
    return { ok: false, status: 'BLOCKED', reason: 'review_sha_mismatch' };
  }
  if (review.candidate_id !== verification.candidate_id) {
    return { ok: false, status: 'BLOCKED', reason: 'review_candidate_mismatch' };
  }
  if (review.review_status === REVIEW_STATUS.PASS) {
    return { ok: true, status: 'PASS', reason: 'codex_pass' };
  }
  if (review.review_status === REVIEW_STATUS.REQUEST_CHANGES) {
    return { ok: false, status: 'FAIL', reason: 'request_changes' };
  }
  return { ok: false, status: 'BLOCKED', reason: 'review_blocked' };
}

export function invalidateReview(core, reviewId, reason) {
  return co(function* () {
    const review = yield core.store.getReview(reviewId);
    if (!review) {
      throw new CodexReviewError(`unknown review_id: ${reviewId}`, 'UNKNOWN_REVIEW');
    }
    const updated = yield core.store.updateReview(reviewId, {
      invalidated_at: nowIso(),
      invalidation_reason: reason || 'invalidated',
    });
    const candidate = yield core.store.getCandidate(review.candidate_id);
    yield core.store.appendEvent({
      task_id: candidate?.task_id,
      factory_run_id: candidate?.factory_run_id,
      event_type: EVENT_TYPE.REVIEW_INVALIDATED,
      payload: {
        review_id: reviewId,
        commit_sha: review.commit_sha,
        reason,
      },
    });
    return updated;
  });
}

export function isReviewAuthoritative(core, reviewId) {
  return co(function* () {
    const review = yield core.store.getReview(reviewId);
    if (!review || review.invalidated_at) return false;
    if (review.review_status !== REVIEW_STATUS.PASS) return false;
    const candidate = yield core.store.getCandidate(review.candidate_id);
    if (!candidate) return false;
    if (candidate.status !== CANDIDATE_STATUS.VERIFIED) return false;
    if (candidate.review_ref !== reviewId) return false;
    if (candidate.commit_sha !== review.commit_sha) return false;
    if (!candidate.verification_ref) return false;
    const boundVerificationId = review.evidence?.verification_id;
    if (!boundVerificationId || boundVerificationId !== candidate.verification_ref) {
      return false;
    }
    if (!(yield isVerificationAuthoritative(core, candidate.verification_ref))) return false;
    return true;
  });
}

/** Reviewer path must never mutate task/candidate/acceptance locked fields. */
export function assertReviewerCannotMutate(core, taskId, patch) {
  const forbidden = [
    'intent',
    'acceptance_ref',
    'allowed_paths',
    'tool_manifest',
    'content_hash',
    'proposal_id',
    'review_required',
  ];
  for (const key of forbidden) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
      throw new CodexReviewError(
        `reviewer cannot mutate locked field: ${key}`,
        'REVIEWER_MUTATION_FORBIDDEN'
      );
    }
  }
  // Also refuse candidate commit rewrite through this helper.
  if (patch?.commit_sha) {
    throw new CodexReviewError(
      'reviewer cannot mutate candidate commit_sha',
      'REVIEWER_MUTATION_FORBIDDEN'
    );
  }
  return true;
}
