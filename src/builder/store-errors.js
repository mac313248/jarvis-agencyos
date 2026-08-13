import { redactString } from './secrets-redact.js';

export class BuilderStoreError extends Error {
  constructor(reason, code = 'STORE_ERROR') {
    const safe = redactString(String(reason || 'builder store error'));
    super(safe);
    this.name = 'BuilderStoreError';
    this.code = code;
    this.reason = safe;
  }
}

export function isUniqueViolation(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === '23505') return true;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return true;
  }
  const msg = String(err.message || '');
  return (
    /UNIQUE constraint failed/i.test(msg) ||
    /duplicate key value/i.test(msg) ||
    /already exists/i.test(msg)
  );
}

const REGAIN_AUTHORITY_STATUSES = new Set([
  'PENDING',
  'LAUNCHED',
  'RUNNING',
  'SUCCEEDED',
]);

export function assertRunCannotRegainAuthority(current, patch) {
  if (!current) return;
  if (current.status !== 'STALE' && current.status !== 'CANCELLED') return;
  const next = patch?.status;
  if (next && REGAIN_AUTHORITY_STATUSES.has(next)) {
    throw new BuilderStoreError(
      `stale/cancelled run cannot regain authority: ${current.factory_run_id}`,
      'STALE_RUN'
    );
  }
}
