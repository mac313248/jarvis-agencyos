// Builder Core store configuration.
// SQLite remains the local/test default. PostgreSQL is required for
// unattended Automation. Shared mode fails closed — never falls back to
// a disposable sandbox SQLite file.

export const BUILDER_STORE_KIND = Object.freeze({
  SQLITE: 'sqlite',
  POSTGRES: 'postgres',
});

export const DEFAULT_SQLITE_PATH = '.data/builder/jarvis-tasks.sqlite';
export const BUILDER_PG_SCHEMA = 'jarvis_builder';
export const ACTIVE_CODING_LEASE_KEY = 'active_coding_run';

export class BuilderStoreConfigError extends Error {
  constructor(message, code = 'BUILDER_STORE_CONFIG') {
    super(message);
    this.name = 'BuilderStoreConfigError';
    this.code = code;
  }
}

export function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT') {
    return true;
  }
  const msg = String(err.message || '');
  return /unique constraint/i.test(msg) || /duplicate key/i.test(msg);
}

function trim(value) {
  return String(value || '').trim();
}

export function isUnattendedBuilderMode(env = process.env) {
  const store = trim(env.JARVIS_BUILDER_STORE).toLowerCase();
  return (
    store === BUILDER_STORE_KIND.POSTGRES ||
    env.JARVIS_BUILDER_UNATTENDED === '1' ||
    env.JARVIS_BUILDER_AUTOMATION === '1' ||
    env.JARVIS_TICK_UNATTENDED === '1'
  );
}

export function assertSafeSchemaName(schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new BuilderStoreConfigError(
      'invalid Builder Postgres schema name',
      'INVALID_BUILDER_SCHEMA'
    );
  }
  return schema;
}

/**
 * Resolve store mode from env. Shared/unattended mode never returns sqlite.
 */
export function resolveBuilderStoreConfig(env = process.env, { dbPath = null } = {}) {
  const requested = trim(env.JARVIS_BUILDER_STORE).toLowerCase();
  const url = trim(env.JARVIS_BUILDER_DATABASE_URL);
  const unattended = isUnattendedBuilderMode(env);
  const schema = assertSafeSchemaName(
    trim(env.JARVIS_BUILDER_SCHEMA) || BUILDER_PG_SCHEMA
  );

  if (unattended || requested === BUILDER_STORE_KIND.POSTGRES) {
    if (requested === BUILDER_STORE_KIND.SQLITE) {
      return {
        ok: false,
        kind: BUILDER_STORE_KIND.POSTGRES,
        required: true,
        sqliteForbidden: true,
        reason: 'SHARED_STORE_REQUIRED',
        schema,
      };
    }
    if (!url) {
      return {
        ok: false,
        kind: BUILDER_STORE_KIND.POSTGRES,
        required: true,
        sqliteForbidden: true,
        reason: 'MISSING_SHARED_BUILDER_DATABASE',
        schema,
      };
    }
    return {
      ok: true,
      kind: BUILDER_STORE_KIND.POSTGRES,
      required: true,
      sqliteForbidden: true,
      databaseUrl: url,
      schema,
    };
  }

  if (requested && requested !== BUILDER_STORE_KIND.SQLITE) {
    return {
      ok: false,
      kind: requested,
      required: false,
      sqliteForbidden: false,
      reason: 'UNKNOWN_BUILDER_STORE',
    };
  }

  return {
    ok: true,
    kind: BUILDER_STORE_KIND.SQLITE,
    required: false,
    sqliteForbidden: false,
    dbPath:
      dbPath ||
      trim(env.JARVIS_BUILDER_DB) ||
      DEFAULT_SQLITE_PATH,
  };
}

export function blockedStoreDecision(reason) {
  return {
    decision: 'BLOCKED',
    reason,
    task_id: null,
    factory_run_id: null,
    provider_run_id: null,
    provider: null,
    worker_contract: null,
    pr: null,
    head_sha: null,
    owner_action:
      reason === 'MISSING_SHARED_BUILDER_DATABASE'
        ? 'Set JARVIS_BUILDER_STORE=postgres and JARVIS_BUILDER_DATABASE_URL to a dedicated jarvis_builder database.'
        : reason === 'SHARED_BUILDER_DATABASE_UNREACHABLE'
          ? 'Shared Builder Postgres is unreachable. Restore JARVIS_BUILDER_DATABASE_URL connectivity.'
          : null,
    logical_work_id: null,
    dispatched: false,
  };
}
