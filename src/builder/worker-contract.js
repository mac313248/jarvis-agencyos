// Bounded worker-contract materialization for jarvis:tick.
// Workers receive scope and verification commands only. They cannot set
// PASS/DONE or advance phases.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function workerContractRelPath(factoryRunId) {
  return join('control/runs', factoryRunId, 'worker-contract.md');
}

export function buildWorkerContractMarkdown({
  task,
  factory_run_id,
  head_sha,
  orientation,
  verification_commands = [],
} = {}) {
  const allowed = Array.isArray(task?.allowed_paths) ? task.allowed_paths : [];
  const tools = task?.tool_manifest || {};
  const commands = verification_commands.length
    ? verification_commands
    : ['npm run verify:sot', 'npm test'];
  return [
    '# Worker contract',
    '',
    'You are the Cursor execution-plane worker for one Jarvis Builder task.',
    'Jarvis / Builder Core remains the authority plane.',
    '',
    '## Identity',
    '',
    `- task_id: ${task?.task_id || ''}`,
    `- factory_run_id: ${factory_run_id || ''}`,
    `- head_sha: ${head_sha || ''}`,
    `- provider: cursor`,
    '',
    '## Locked intent',
    '',
    `- intent: ${task?.intent || ''}`,
    `- acceptance_ref: ${task?.acceptance_ref || ''}`,
    `- allowed_paths: ${JSON.stringify(allowed)}`,
    `- allowed_tools: ${JSON.stringify(tools)}`,
    `- active_work_state: ${orientation?.active_work_state || ''}`,
    `- next_phase_candidate: ${orientation?.next_phase_candidate || ''}`,
    '',
    '## Required verification',
    '',
    ...commands.map((c) => `- ${c}`),
    '',
    '## Forbidden',
    '',
    '- Do not set PASS, DONE, ACCEPTED, or otherwise self-certify completion.',
    '- Do not advance phases or treat orientation as release-gate proof.',
    '- Do not use production or business credentials.',
    '- Do not work outside allowed_paths.',
    '- Do not enable Hermes, voice, Obsidian, Prime, extra coding workers, or new product scope.',
    '- Do not enable the live Jarvis Builder Automation.',
    '',
  ].join('\n');
}

export function writeWorkerContract(root, payload) {
  const rel = workerContractRelPath(payload.factory_run_id);
  const abs = join(root, rel);
  mkdirSync(join(root, 'control/runs', payload.factory_run_id), { recursive: true });
  writeFileSync(abs, buildWorkerContractMarkdown(payload));
  return rel;
}
