# 08 — RUNTIME, WORKFLOWS & SPECIALISTS

### SPECIALISTS

Available V1 specialist contracts remain:

**Scout** — discovers information/evidence.

**Analyst** — reasons over structured evidence.

**Builder** — creates software/assets/configuration.

**Operator** — performs governed operational tasks.

**Reviewer** — independent verification when required.

But the execution rule is:

`ONE AGENT`
→ solve if adequate
→ delegate only if justified.

Independent research now reinforces this strongly: coordination adds overhead and can propagate failures; task topology matters more than agent count. ([Nature](https://www.nature.com/articles/s42256-026-01268-y?utm_source=chatgpt.com "Capable language models can outgrow the benefits of collaboration | Nature Machine Intelligence"))

No:

- permanent department swarm;
- recursive autonomous hierarchy;
- unrestricted peer chat;
- agents negotiating authority;
- agent-created specialists with new permissions.

### CODING FACTORY

Do **not** rebuild a giant custom coding factory.

Final architecture:

`AgencyOS task envelope`
→ Cursor / Codex / other qualified native coding runtime
→ branch/worktree/isolated environment
→ implementation
→ tests
→ PR
→ GitHub CI
→ required gates
→ merge authorization.

Cursor already supplies isolated cloud-agent environments capable of building, testing, computer use and producing reviewable work, which materially reduces the infrastructure AgencyOS needs to recreate. ([Cursor](https://cursor.com/blog/agent-computer-use?utm_source=chatgpt.com "Cursor agents can now control their own computers · Cursor"))

AgencyOS custom software-factory code is limited to:

- task/spec envelope;
- provider launch/status/cancel;
- run/PR registry;
- acceptance/gate reader;
- bounded repair;
- receipts/trace linkage.

The old Planner → Builder → Reviewer → Test Author → custom harness architecture is eliminated as a mandatory pipeline.

### DURABLE WORKFLOWS

**V1 = DBOS Transact + Postgres.**

DBOS currently provides Postgres-backed durable workflows that recover from completed checkpoints and supports long-running processes, queues and human waits without requiring a separate workflow orchestration server. ([DBOS Docs](https://docs.dbos.dev/typescript/integrating-dbos?utm_source=chatgpt.com "Add DBOS To Your App | DBOS Docs"))

Rule:

> Every nondeterministic LLM call, tool call or external interaction inside a durable process becomes a durable step.

DBOS owns:

- workflow execution;
- waiting;
- retries;
- queues;
- signals;
- checkpoint/recovery.

AgencyOS owns:

- product state;
- authority;
- external-write idempotency;
- external verification;
- business receipts.

DBOS does **not** magically make an external API side effect exactly once. External writes still require our idempotency key and postcondition verifier.

Temporal/Restate are later escalation options if actual scale/distribution requirements justify them.
