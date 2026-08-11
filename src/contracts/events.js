// src/contracts/events.js
// CanonicalEvent authenticity boundary per 06_SYSTEM_CONTRACTS.md.
//
// Rule: an event whose authenticity_status is FAILED or UNKNOWN, on an event
// type that requires provider authentication, CANNOT materialize canonical
// business state. It may only create a security/source-health event.
//
// Authenticated origin does NOT make payload text semantically trusted
// (content_trust stays UNTRUSTED_PAYLOAD unless structured/verified).

// Event types that require provider authentication before they may
// materialize canonical business state. (Phase 1: a small deterministic
// registry; later phases read this from the connector registry.)
export const AUTH_REQUIRED_EVENT_TYPES = new Set([
  'provider.invoice.created',
  'provider.payment.received',
  'provider.appointment.booked',
  'provider.message.received',
]);

export function isAuthenticitySatisfied(status) {
  return status === 'VERIFIED' || status === 'NOT_APPLICABLE';
}

// Decide whether an inbound event may materialize canonical business state.
// Returns { mayMaterialize: boolean, reason }.
export function canMaterializeCanonicalState({ event_type, authenticity_status, content_trust }) {
  if (!AUTH_REQUIRED_EVENT_TYPES.has(event_type)) {
    return { mayMaterialize: true, reason: 'event type does not require provider auth' };
  }
  if (!isAuthenticitySatisfied(authenticity_status)) {
    return {
      mayMaterialize: false,
      reason: `authenticity_status=${authenticity_status} on auth-required event; cannot materialize canonical state`,
    };
  }
  // content_trust is informational: authenticated origin does not make payload
  // text into trusted instructions. Materialization here means persisting the
  // canonical event record + current_state update derived from STRUCTURED,
  // verified fields, never from free-form payload text.
  return { mayMaterialize: true, reason: 'authenticity satisfied; structured materialization permitted' };
}

// Deterministic fake/test adapter proving the enforcement boundary.
// A real provider adapter is NOT required in Phase 1.
export function fakeProviderAdapter({ signatureValid, signaturePresent }) {
  if (!signaturePresent) return { authenticity_status: 'UNKNOWN', authenticity_method: 'fake-adapter:none' };
  return signatureValid
    ? { authenticity_status: 'VERIFIED', authenticity_method: 'fake-adapter:hmac-sha256' }
    : { authenticity_status: 'FAILED', authenticity_method: 'fake-adapter:hmac-sha256' };
}
