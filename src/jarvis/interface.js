// src/jarvis/interface.js
// Jarvis Interface — owner-facing mediator (Stage 1).
//
// Owns conversational/command mediation only. Deterministic software-work
// authority lives in Builder Core. Future AgencyOS Business Core remains a
// separate trust domain and is not reachable from this Stage-1 surface.

import {
  TRUST_DOMAIN,
  createBuilderCore,
} from '../builder/index.js';

export const JARVIS_COMMANDS = Object.freeze({
  CREATE_DRAFT_TASK: 'CREATE_DRAFT_TASK',
  LOCK_TASK: 'LOCK_TASK',
  CREATE_AND_LOCK_TASK: 'CREATE_AND_LOCK_TASK',
  GET_TASK: 'GET_TASK',
  VERIFY_LOCKED_TASK: 'VERIFY_LOCKED_TASK',
  UPDATE_TASK_STATUS: 'UPDATE_TASK_STATUS',
  CREATE_RUN: 'CREATE_RUN',
  RECORD_CANDIDATE: 'RECORD_CANDIDATE',
  RECORD_APPROVAL: 'RECORD_APPROVAL',
  RECONSTRUCT: 'RECONSTRUCT',
  STATUS: 'STATUS',
});

export class JarvisInterfaceError extends Error {
  constructor(reason) {
    super(`jarvis interface error: ${reason}`);
    this.name = 'JarvisInterfaceError';
    this.reason = reason;
  }
}

export class JarvisInterface {
  constructor({ builderCore, dbPath = ':memory:' } = {}) {
    this.trustDomain = TRUST_DOMAIN.JARVIS_INTERFACE;
    this.builder = builderCore || createBuilderCore({ dbPath });
  }

  close() {
    this.builder.close();
  }

  // Typed command entrypoint — models/prompts are not the authority boundary.
  dispatch(command, payload = {}) {
    switch (command) {
      case JARVIS_COMMANDS.CREATE_DRAFT_TASK:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.createDraftTask(payload),
        };
      case JARVIS_COMMANDS.LOCK_TASK:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.lockTask(payload.task_id),
        };
      case JARVIS_COMMANDS.CREATE_AND_LOCK_TASK:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.createAndLockTask(payload),
        };
      case JARVIS_COMMANDS.GET_TASK:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.getTask(payload.task_id),
        };
      case JARVIS_COMMANDS.VERIFY_LOCKED_TASK:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.verifyLockedTask(payload.task_id),
        };
      case JARVIS_COMMANDS.UPDATE_TASK_STATUS:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.updateTaskStatus(payload.task_id, payload.status),
        };
      case JARVIS_COMMANDS.CREATE_RUN:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.createRun(payload),
        };
      case JARVIS_COMMANDS.RECORD_CANDIDATE:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.recordCandidate(payload),
        };
      case JARVIS_COMMANDS.RECORD_APPROVAL:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.recordApproval(payload),
        };
      case JARVIS_COMMANDS.RECONSTRUCT:
        return {
          trust_domain: this.trustDomain,
          delegated_to: TRUST_DOMAIN.BUILDER_CORE,
          result: this.builder.reconstruct(),
        };
      case JARVIS_COMMANDS.STATUS:
        return {
          trust_domain: this.trustDomain,
          builder_trust_domain: this.builder.trustDomain,
          authority: {
            jarvis_interface: 'owner mediator / typed commands',
            builder_core: 'software-work state / verification authority',
            agencyos_business_core: 'NOT_IN_STAGE1_SCOPE',
          },
        };
      default:
        throw new JarvisInterfaceError(`unknown command: ${command}`);
    }
  }
}

export function createJarvisInterface(options) {
  return new JarvisInterface(options);
}
