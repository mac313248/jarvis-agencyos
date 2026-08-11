export class BuilderCoreError extends Error {
  constructor(reason, code = 'BUILDER_CORE_ERROR') {
    super(reason);
    this.name = 'BuilderCoreError';
    this.code = code;
    this.reason = reason;
  }
}
