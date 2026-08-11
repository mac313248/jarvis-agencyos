import { redactString } from './secrets-redact.js';

export class BuilderCoreError extends Error {
  constructor(reason, code = 'BUILDER_CORE_ERROR') {
    const safe = redactString(String(reason || 'builder error'));
    super(safe);
    this.name = 'BuilderCoreError';
    this.code = code;
    this.reason = safe;
  }
}
