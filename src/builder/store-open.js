// Open a Builder Core store from resolved configuration.
// Shared/postgres mode fails closed and never creates a local SQLite file.

import { openBuilderStore } from './store.js';
import { openPostgresBuilderStore } from './store-postgres.js';
import {
  BUILDER_STORE_KIND,
  BuilderStoreConfigError,
  resolveBuilderStoreConfig,
} from './store-config.js';

export async function openBuilderStoreFromConfig(config, env = process.env) {
  const resolved = config && config.kind
    ? config
    : resolveBuilderStoreConfig(env, config || {});
  if (!resolved.ok) {
    throw new BuilderStoreConfigError(
      resolved.reason === 'MISSING_SHARED_BUILDER_DATABASE'
        ? 'JARVIS_BUILDER_STORE=postgres requires JARVIS_BUILDER_DATABASE_URL'
        : resolved.reason || 'builder store configuration is invalid',
      resolved.reason || 'BUILDER_STORE_CONFIG'
    );
  }
  if (resolved.kind === BUILDER_STORE_KIND.POSTGRES) {
    return openPostgresBuilderStore(resolved.databaseUrl, {
      schema: resolved.schema,
    });
  }
  if (resolved.sqliteForbidden) {
    throw new BuilderStoreConfigError(
      'shared Builder mode cannot use SQLite',
      'SHARED_STORE_REQUIRED'
    );
  }
  return openBuilderStore(resolved.dbPath || ':memory:');
}

export function sandboxOwnerId(env = process.env) {
  return (
    env.CURSOR_CLOUD_AGENT_ID ||
    env.CURSOR_AGENT_ID ||
    `pid:${process.pid}`
  );
}
