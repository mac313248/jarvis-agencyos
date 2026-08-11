// src/runtime/local-effect-adapter.js
// Local/fake effect boundary for F-08. Simulates an idempotent provider store
// WITHOUT live external side effects. Business-write autonomy remains DISABLED.
//
// The in-memory (or injected Map) store is the "external" system of record used
// to prove at-most-once commit and crash-after-commit recovery.

import { randomUUID } from 'node:crypto';

export const LOCAL_FAKE_SURFACE = 'local_fake';

/**
 * @param {Map<string, object>} [store]
 * @param {{ defaultPostcondition?: 'VERIFIED'|'AMBIGUOUS'|'UNKNOWN'|'FAILED'|'ABSENT' }} [opts]
 */
export function createLocalEffectAdapter(store = new Map(), opts = {}) {
  const defaultPostcondition = opts.defaultPostcondition ?? 'VERIFIED';

  return {
    surface: LOCAL_FAKE_SURFACE,

    hasCommitted(idempotencyKey) {
      return store.has(idempotencyKey);
    },

    getCommitted(idempotencyKey) {
      return store.get(idempotencyKey) ?? null;
    },

    async commit({ idempotency_key, request }) {
      if (store.has(idempotency_key)) {
        const existing = store.get(idempotency_key);
        return {
          already_present: true,
          commit_token: existing.commit_token,
          committed_at: existing.committed_at,
        };
      }
      const record = {
        commit_token: randomUUID(),
        request,
        committed_at: new Date().toISOString(),
      };
      store.set(idempotency_key, record);
      return {
        already_present: false,
        commit_token: record.commit_token,
        committed_at: record.committed_at,
      };
    },

    /**
     * Observe whether the logical effect is present.
     * Returns VERIFIED | AMBIGUOUS | UNKNOWN | FAILED | ABSENT.
     */
    async verifyPostcondition({ idempotency_key, forcedStatus = null }) {
      const status = forcedStatus ?? defaultPostcondition;
      if (status === 'ABSENT') {
        return { status: 'ABSENT', present: false };
      }
      if (status === 'UNKNOWN' || status === 'AMBIGUOUS') {
        return { status, present: null };
      }
      if (status === 'FAILED') {
        return { status: 'FAILED', present: false };
      }
      // VERIFIED requires the store to actually hold the commit.
      if (!store.has(idempotency_key)) {
        return { status: 'ABSENT', present: false };
      }
      return {
        status: 'VERIFIED',
        present: true,
        commit_token: store.get(idempotency_key).commit_token,
      };
    },

    get store() {
      return store;
    },
  };
}
