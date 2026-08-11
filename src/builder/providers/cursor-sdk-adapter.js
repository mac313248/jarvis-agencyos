// Thin adapter over official @cursor/sdk.
// No invented endpoints. Failures are preserved as thrown SDK errors.

import { Agent, Cursor } from '@cursor/sdk';

export function createCursorSdkAdapter(sdk = { Agent, Cursor }) {
  return {
    async listModels(apiKey) {
      return sdk.Cursor.models.list({ apiKey });
    },
    async createAgent(options) {
      return sdk.Agent.create(options);
    },
    async getRun(runId, options) {
      return sdk.Agent.getRun(runId, options);
    },
    async cancelRun(runId, options) {
      if (typeof sdk.Agent.cancelRun === 'function') {
        return sdk.Agent.cancelRun(runId, options);
      }
      const run = await sdk.Agent.getRun(runId, options);
      if (run.supports && !run.supports('cancel')) {
        throw new Error(run.unsupportedReason?.('cancel') || 'cancel unsupported');
      }
      return run.cancel();
    },
    async resumeAgent(agentId, options) {
      return sdk.Agent.resume(agentId, options);
    },
  };
}
