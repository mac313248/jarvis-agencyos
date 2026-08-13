// Exclusive tick lock so duplicate triggers cannot claim the same work twice.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class TickLockError extends Error {
  constructor(message, code = 'TICK_LOCK') {
    super(message);
    this.name = 'TickLockError';
    this.code = code;
  }
}

export function tickLockDir(root) {
  return join(root, '.data/builder/jarvis-tick.lock');
}

export function acquireTickLock(root, { owner = process.pid, now = Date.now() } = {}) {
  const parent = join(root, '.data/builder');
  mkdirSync(parent, { recursive: true });
  const dir = tickLockDir(root);
  try {
    mkdirSync(dir);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new TickLockError('duplicate trigger: tick lock already held', 'DUPLICATE_TRIGGER');
    }
    throw err;
  }
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({
    owner,
    acquired_at: new Date(now).toISOString(),
  }) + '\n');
  return {
    dir,
    release() {
      releaseTickLock(root);
    },
  };
}

export function releaseTickLock(root) {
  const dir = tickLockDir(root);
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort release; next acquire still fails closed on EEXIST.
  }
}

export function readTickLock(root) {
  const file = join(tickLockDir(root), 'owner.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { owner: 'unreadable' };
  }
}
