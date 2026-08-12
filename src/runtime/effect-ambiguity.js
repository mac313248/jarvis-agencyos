// src/runtime/effect-ambiguity.js
// V1.0C ambiguous-effect + cross-surface fallback gates.
// Wired for trusted-executor retry/fallback decisions.
// Business-write autonomy remains DISABLED.

import { classifyAmbiguousOutcomePolicy } from '../contracts/capability.js';

export class EffectAmbiguityError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EffectAmbiguityError';
    this.code = code;
    this.details = details;
  }
}

const BROWSER_ORGO_SURFACES = new Set([
  'browser',
  'orgo',
  'browser_orgo',
  'browser_orgo_fallback',
]);

/**
 * #28 — Provider without idempotency and without observable postcondition
 * cannot autonomously retry after an ambiguous outcome.
 */
export function assertAutonomousRetryAllowedAfterAmbiguity(capability, {
  prior_outcome = null,
  prior_postcondition = null,
} = {}) {
  const ambiguous =
    prior_outcome === 'AMBIGUOUS' ||
    prior_postcondition === 'AMBIGUOUS' ||
    prior_postcondition === 'UNKNOWN' ||
    prior_postcondition === 'UNVERIFIED';

  if (!ambiguous) {
    return { allowed: true, reason_codes: [] };
  }

  const policy = classifyAmbiguousOutcomePolicy(capability);
  if (!policy.autonomously_retryable_after_ambiguity) {
    throw new EffectAmbiguityError(
      'AUTONOMOUS_RETRY_FORBIDDEN_AFTER_AMBIGUITY',
      'provider lacks idempotency and/or observable postcondition; autonomous retry after ambiguity is forbidden',
      {
        ambiguous_completion: policy.ambiguous_completion,
        reason_codes: policy.reason_codes,
        prior_outcome,
        prior_postcondition,
      }
    );
  }
  return { allowed: true, reason_codes: policy.reason_codes };
}

/**
 * #29 — Browser/Orgo fallback only after the prior API/MCP/CLI effect is
 * VERIFIED ABSENT. UNKNOWN/AMBIGUOUS/PRESENT → STOP.
 *
 * Caller-supplied postcondition alone is insufficient: durableEvidence must
 * be true (ledger/receipt/recon backed) or the call fails closed.
 */
export function assertCrossSurfaceFallbackAllowed({
  prior_surface = 'api',
  fallback_surface,
  postcondition_status,
  durable_evidence = false,
} = {}) {
  if (!fallback_surface) {
    return { allowed: true, reason_codes: [] };
  }

  const isBrowserOrgo = BROWSER_ORGO_SURFACES.has(String(fallback_surface).toLowerCase());
  if (!isBrowserOrgo) {
    return { allowed: true, reason_codes: [] };
  }

  if (!durable_evidence) {
    throw new EffectAmbiguityError(
      'FALLBACK_REQUIRES_DURABLE_POSTCONDITION',
      'browser/Orgo fallback requires durable ledger/receipt postcondition evidence; caller-only claims are refused',
      { prior_surface, fallback_surface, postcondition_status: postcondition_status || null }
    );
  }

  const status = String(postcondition_status || '').toUpperCase();
  const verifiedAbsent = status === 'ABSENT' || status === 'VERIFIED_ABSENT';
  if (!verifiedAbsent) {
    throw new EffectAmbiguityError(
      'BROWSER_ORGO_FALLBACK_FORBIDDEN',
      'browser/Orgo fallback requires prior effect VERIFIED ABSENT; UNKNOWN/AMBIGUOUS/PRESENT must STOP',
      {
        prior_surface,
        fallback_surface,
        postcondition_status: status || null,
      }
    );
  }
  return {
    allowed: true,
    reason_codes: ['PRIOR_EFFECT_VERIFIED_ABSENT'],
  };
}
