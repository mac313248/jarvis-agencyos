// src/db/index.js
// Database abstraction for Phase 1.
//
// Engine selection (reversible, environment-driven):
//   - Default: PGlite (real PostgreSQL compiled to WASM). Runs in-process,
//     no shared memory, no external server. Used for deterministic Phase 1
//     tests. The RLS engine, pg_roles catalog, FORCE RLS, BYPASSRLS, and
//     transaction-local GUC semantics are the real PostgreSQL implementation.
//   - Optional: node 'pg' driver against a real multi-process PostgreSQL when
//     process.env.DATABASE_URL is set. Same SQL/migrations/tests run unchanged.
//
// Both backends expose the same minimal surface used by the migrator, the
// security primitives, and the tests: query(), exec(), tx(), and a way to
// switch the effective role (SET ROLE) for runtime-role testing.

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  PGlite = null;
}

function parseUrl(url) {
  const m = /^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/.exec(url);
  if (!m) throw new Error(`Unsupported DATABASE_URL: ${url}`);
  return { user: m[1], password: m[2], host: m[3], port: Number(m[4]), database: m[5] };
}

export async function createDb({ dataDir, databaseUrl } = {}) {
  const url = databaseUrl || process.env.DATABASE_URL;
  if (url) {
    const pg = (await import('pg')).default;
    const cfg = parseUrl(url);
    const pool = new pg.Pool({ ...cfg, max: 8 });
    return makeBackend({
      kind: 'pg',
      query: async (text, params) => {
        const c = await pool.connect();
        try {
          return await c.query(text, params || []);
        } finally {
          c.release();
        }
      },
      tx: async (fn) => {
        const c = await pool.connect();
        let inTxn = false;
        try {
          await c.query('BEGIN');
          inTxn = true;
          const api = {
            query: (t, p) => c.query(t, p || []),
            exec: (t, p) => c.query(t, p || []),
          };
          const res = await fn(api);
          await c.query('COMMIT');
          inTxn = false;
          return res;
        } finally {
          if (inTxn) { try { await c.query('ROLLBACK'); } catch {} }
          c.release();
        }
      },
      pool,
      close: async () => { await pool.end(); },
    });
  }

  if (!PGlite) throw new Error('PGlite not installed and DATABASE_URL not set');
  const { mkdir } = await import('node:fs/promises');
  const dir = dataDir || './.pgdata/phase1';
  await mkdir(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.exec(''); // ensure ready
  return makeBackend({
    kind: 'pglite',
    query: async (text, params) => db.query(text, params || []),
    exec: async (text) => db.exec(text),
    tx: async (fn) => {
      await db.exec('BEGIN');
      let inTxn = true;
      try {
        const api = {
          query: (t, p) => db.query(t, p || []),
          exec: (t) => db.exec(t),
        };
        const res = await fn(api);
        await db.exec('COMMIT');
        inTxn = false;
        return res;
      } finally {
        if (inTxn) { try { await db.exec('ROLLBACK'); } catch {} }
      }
    },
    raw: db,
    close: async () => { try { await db.close(); } catch {} },
  });
}

function makeBackend(b) {
  b.exec = b.exec || (async (text) => b.query(text));
  return b;
}

// Helper: run a callback under a specific effective role (SET ROLE ...).
// Used to exercise the non-superuser runtime role for RLS testing. The
// underlying connection remains the bootstrap/migrator connection, but
// current_user becomes the target role so RLS/BYPASSRLS/permission checks
// apply to that role, exactly as the PostgreSQL docs recommend for RLS tests.
export async function asRole(backend, roleName, fn) {
  await backend.query(`SET ROLE ${roleName};`);
  try {
    return await fn(backend);
  } finally {
    await backend.query('RESET ROLE;');
  }
}

export async function serverVersion(backend) {
  const r = await backend.query('SHOW server_version;');
  return r.rows?.[0]?.server_version || String(r);
}
