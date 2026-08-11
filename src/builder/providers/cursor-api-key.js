// Cursor API key loader for Builder Stage 1.
// Authoritative durable store: macOS Keychain service agencyos.cursor.api_key.
// Never logs/prints/returns key material except as the in-memory secret value
// passed directly to the Cursor SDK. Env is ephemeral inject only — not a store.

import { execFileSync } from 'node:child_process';
import { redactString } from '../secrets-redact.js';

export const CURSOR_KEYCHAIN_SERVICE = 'agencyos.cursor.api_key';

function readKeychainApiKey({ env, execFileSyncFn }) {
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
    throw new Error('keychain returned empty credential');
  }
  return apiKey;
}

/**
 * Load Cursor API key for in-memory SDK use only.
 * Prefer keychain. Optional env inject is never written to disk by this module.
 */
export function loadCursorApiKey({
  env = process.env,
  execFileSyncFn = execFileSync,
  allowKeychain = true,
  allowEnv = true,
} = {}) {
  if (allowKeychain) {
    try {
      const apiKey = readKeychainApiKey({ env, execFileSyncFn });
      return { source: 'keychain', apiKey };
    } catch {
      // Fall through to env inject if enabled; never embed keychain stderr/stdout.
    }
  }

  if (allowEnv) {
    const fromEnv =
      typeof env.CURSOR_API_KEY === 'string' ? env.CURSOR_API_KEY.trim() : '';
    if (fromEnv) return { source: 'env', apiKey: fromEnv };
  }

  if (!allowKeychain && !allowEnv) {
    throw new Error('CURSOR_API_KEY unavailable: keychain and env lookup disabled');
  }

  throw new Error(
    `CURSOR_API_KEY unavailable via keychain (${CURSOR_KEYCHAIN_SERVICE})` +
      (allowEnv ? ' or env inject' : '')
  );
}

/** Sanitize any accidental key material from credential-related error text. */
export function safeCredentialErrorMessage(message, apiKey = null) {
  return redactString(String(message || 'credential error'), apiKey ? [apiKey] : []);
}
