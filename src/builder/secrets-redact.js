// Secret redaction for Builder Stage 1.
// Never log, serialize, or throw raw credential material.

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_RE =
  /^(?:CURSOR_API_KEY|OPENAI_API_KEY|CODEX_API_KEY|GITHUB_TOKEN|GH_TOKEN|DATABASE_URL|.*_DATABASE_URL|JARVIS_BUILDER_DATABASE_URL|PGPASSWORD|PGUSER|PGHOST|PGDATABASE|POSTGRES_.*|GHL_.*|HIGHLEVEL_.*|META_.*|FACEBOOK_.*|STRIPE_.*|PAYMENT_.*|PAYPAL_.*|TWILIO_.*|.*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?))$/i;

const SENSITIVE_VALUE_HINT_RE =
  /\b(?:crsr_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|ghl_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g;

export function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ''));
}

export function redactString(text, extraSecrets = []) {
  let out = String(text ?? '');
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join(REDACTED);
    }
  }
  out = out.replace(SENSITIVE_VALUE_HINT_RE, REDACTED);
  // Key=value and JSON "key":"value" forms for common secret names.
  out = out.replace(
    /((?:CURSOR_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|[A-Z0-9_]+(?:_KEY|_TOKEN|_SECRET|_PASSWORD))\s*[=:]\s*)(["']?)([^"',\s}]+)(\2)/gi,
    `$1$2${REDACTED}$4`
  );
  out = out.replace(
    /("(?:CURSOR_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|[A-Za-z0-9_]+(?:_KEY|_TOKEN|_SECRET|_PASSWORD))"\s*:\s*)(")(?:\\.|[^"\\])*(")/gi,
    `$1$2${REDACTED}$3`
  );
  return out;
}

/**
 * Deep-redact objects/arrays/strings. Sensitive keys become [REDACTED].
 * Never returns original secret-bearing structures by reference when mutation is needed.
 */
export function redactSecrets(value, { extraSecrets = [], depth = 0 } = {}) {
  if (depth > 30) return REDACTED;
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value, extraSecrets);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'function') return '[Function]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message, extraSecrets),
      code: value.code ?? undefined,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, { extraSecrets, depth: depth + 1 }));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      // SDK handles often nest apiKey under client/options — kill those shapes.
      if (/^(apiKey|api_key|token|accessToken|authorization|password|secret)$/i.test(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = redactSecrets(v, { extraSecrets, depth: depth + 1 });
    }
    return out;
  }
  return String(value);
}

export function safeJsonStringify(value, extraSecrets = []) {
  try {
    return JSON.stringify(redactSecrets(value, { extraSecrets }));
  } catch {
    return JSON.stringify({ error: REDACTED, reason: 'serialize_failed' });
  }
}

export function safeErrorFields(err, code = null, extraSecrets = []) {
  return {
    name: err?.name || 'Error',
    message: redactString(String(err?.message || err || 'error'), extraSecrets),
    retryable: Boolean(err?.isRetryable ?? err?.retryable),
    code: err?.code || code || 'ERROR',
  };
}
