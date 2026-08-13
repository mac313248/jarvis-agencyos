// Resolve the authoritative Builder store backend.
// Production uses shared PostgreSQL via the Builder control-plane URL.
// SQLite is a local/test fallback only when explicitly allowed.
// Never reuse AgencyOS business-database credentials.

import { BuilderStoreError } from './store-errors.js';
import { BUILDER_ALLOW_SQLITE_ENV, BUILDER_DATABASE_URL_ENV, BUILDER_SQLITE_PATH_ENV, BUILDER_STORE_KIND_ENV } from './store-schema.js';

export const STORE_KIND = Object.freeze({
  SQLITE: 'sqlite',
  POSTGRES: 'postgres',
});

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

export function redactConnectionString(value) {
  if (value == null) return value;
  return String(value).replace(/:([^:@/?#]+)@/g, ':[REDACTED]@');
}

export function resolveBuilderStoreTarget({
  databaseUrl,
  dbPath,
  storeKind,
  allowSqlite,
  env = process.env,
} = {}) {
  const url = firstNonEmpty(databaseUrl, env[BUILDER_DATABASE_URL_ENV]);
  const kind = String(storeKind || env[BUILDER_STORE_KIND_ENV] || '').toLowerCase();
  const envDbPath = firstNonEmpty(env[BUILDER_SQLITE_PATH_ENV]);
  const explicitDbPath = dbPath === undefined ? envDbPath : dbPath;
  const sqliteFlag = allowSqlite === true || env[BUILDER_ALLOW_SQLITE_ENV] === '1';
  const testEnv = env.NODE_ENV === 'test';
  const productionLocked =
    env.NODE_ENV === 'production' ||
    env.JARVIS_CONTROL_PLANE === 'production' ||
    env.JARVIS_CONTROL_PLANE === 'cloud' ||
    kind === STORE_KIND.POSTGRES;

  if (!url && firstNonEmpty(env.DATABASE_URL) && kind === STORE_KIND.POSTGRES) {
    throw new BuilderStoreError(
      `refusing to reuse AgencyOS DATABASE_URL for Builder control plane; set ${BUILDER_DATABASE_URL_ENV}`,
      'SHARED_STORE_UNAVAILABLE'
    );
  }

  if (url) {
    return {
      kind: STORE_KIND.POSTGRES,
      databaseUrl: url,
      sqlite_fallback_disabled: true,
    };
  }

  if (kind === STORE_KIND.POSTGRES) {
    throw new BuilderStoreError(
      `${BUILDER_DATABASE_URL_ENV} is required for the shared Builder store`,
      'SHARED_STORE_UNAVAILABLE'
    );
  }

  const sqliteAllowed =
    sqliteFlag ||
    testEnv ||
    kind === STORE_KIND.SQLITE ||
    (explicitDbPath != null && explicitDbPath !== '' && !productionLocked);

  if (productionLocked && !sqliteAllowed) {
    throw new BuilderStoreError(
      'shared Builder store unavailable; refusing local SQLite fallback',
      'SHARED_STORE_UNAVAILABLE'
    );
  }

  if (!sqliteAllowed) {
    throw new BuilderStoreError(
      `shared Builder store unavailable; set ${BUILDER_DATABASE_URL_ENV} or ${BUILDER_ALLOW_SQLITE_ENV}=1`,
      'SHARED_STORE_UNAVAILABLE'
    );
  }

  return {
    kind: STORE_KIND.SQLITE,
    dbPath: explicitDbPath == null || explicitDbPath === '' ? ':memory:' : explicitDbPath,
    sqlite_fallback_disabled: false,
  };
}
