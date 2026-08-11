// Cursor API key loader for Builder Stage 1.
// Never logs/returns key material to callers beyond the secret itself.
// Prefer explicit env; fall back to the existing Mac Mini keychain item used
// by the local build runner.

import { execFileSync } from 'node:child_process';

export const CURSOR_KEYCHAIN_SERVICE = 'agencyos.cursor.api_key';

export function loadCursorApiKey({
  env = process.env,
  execFileSyncFn = execFileSync,
  allowKeychain = true,
} = {}) {
  const fromEnv = typeof env.CURSOR_API_KEY === 'string' ? env.CURSOR_API_KEY.trim() : '';
  if (fromEnv) return { source: 'env', apiKey: fromEnv };

  if (!allowKeychain) {
    throw new Error('CURSOR_API_KEY missing and keychain lookup disabled');
  }

  try {
    const apiKey = execFileSyncFn(
      'security',
      [
        'find-generic-password',
        '-a',
        env.USER || env.LOGNAME || '',
        '-s',
        CURSOR_KEYCHAIN_SERVICE,
        '-w',
      ],
      { encoding: 'utf8' }
    ).trim();
    if (!apiKey) {
      throw new Error('keychain returned empty CURSOR_API_KEY');
    }
    return { source: 'keychain', apiKey };
  } catch (err) {
    throw new Error(
      `CURSOR_API_KEY unavailable via env or keychain (${CURSOR_KEYCHAIN_SERVICE}): ${err.message}`
    );
  }
}
