# 07 — AUTHORITY, SECURITY & EXECUTION

All schemas referenced here are canonical in `06_SYSTEM_CONTRACTS.md`.

## Security principle

The model is never a security boundary.

The model may request a capability. Only trusted deterministic infrastructure may grant/use it.

Builder Core and coding workers have no ambient AgencyOS business-write authority or production business credentials.

## Tenant isolation

Primary tenant boundary is PostgreSQL RLS + trusted transaction-local tenant context.

Application predicates are defense-in-depth only.

Any cross-tenant RLS bypass is a security incident.

## Owner root of trust

V1:
- one owner human root;
- authenticated session;
- MFA;
- step-up MFA for high-risk grants/approvals;
- approval bound to exact proposal/request hash;
- session/recovery audit.

Two-human approval is deliberately not required in V1 by owner decision.

## Trusted executor flow

`proposal`
→ validate tenant/context
→ resolve capability
→ load active grant/policy
→ validate risk/amount/reversibility
→ validate exact target/arguments
→ load exact proposal-bound approval if needed
→ verify authority/kill stores are healthy
→ re-read mutable preconditions
→ **immediately revalidate revocation + kill epochs**
→ commit effect
→ verify postcondition
→ append receipt
→ update state

If authority/kill-state cannot be freshly verified, material write = DENY.

## Inbound authenticity

External provider webhooks/push events MUST pass the trusted connector/verifier boundary before canonical materialization.

The connector registry stores the verification method/secret/public key reference.

Rules:
- external or unknown/unclassified event origin fails closed unless authenticity is positively verified;
- a trusted-internal path may bypass provider authentication only when non-forgeable provenance is created/enforced by trusted infrastructure;
- caller-supplied connector names, event types, verification objects, `trusted/internal` flags, or equivalent metadata have zero authority to establish trust;
- `NOT_APPLICABLE` is not a generic passthrough for unknown event types.

Failed/unknown authenticity:
- cannot mutate canonical business state;
- creates source-health/security evidence;
- may set affected domain state to UNKNOWN.

Authenticated origin does not make payload text semantically trusted.

## Prompt injection / owner briefing path

Untrusted content remains data.

It cannot:
- become policy,
- change authority,
- alter tenant,
- alter tool grants,
- silently become trusted narrative.

Owner briefings must keep hostile/untrusted-origin claims attributed to their source.

`APPROVE` acts on the proposal object shown to the owner, never on free-form briefing prose.

## Idempotency

Material effect key is deterministic per `06_SYSTEM_CONTRACTS.md`.

After restart/PITR, the same logical step/request generates the same key.

If a provider does not support idempotency:
- verify an observable postcondition before retry/fallback;
- if postcondition is UNKNOWN, do not auto retry;
- escalate to owner/human.

## Cross-surface fallback

After an API/MCP/CLI write returns ambiguous/timed-out:

1. reconcile/verify provider state;
2. if the effect is VERIFIED PRESENT → do not retry;
3. if VERIFIED ABSENT → a bounded fallback may run under the same policy;
4. if UNKNOWN → STOP/BLOCK/HUMAN.

Browser/Orgo cannot be used merely because the API response was inconvenient.

## Agent 0 concurrency

Customer-facing decision workflows are single-flight by:
`tenant + subject + routine + logical stage`.

Late/duplicate events join the active decision workflow.

A semantic action key prevents two independently worded decisions from creating the same logical customer effect.

## Kill / revocation TOCTOU

Epochs are re-read immediately before commit.

The receipt records the exact revocation/kill epochs used.

If an epoch changes after prior authorization but before commit:
- abort;
- refresh;
- reauthorize;
- verify whether any external effect already happened.

## Reconciliation safety

A resource with:
- pending execution,
- ambiguous receipt,
- unreconciled local write

cannot be auto-overwritten from provider state as ordinary drift.

It becomes `CONFLICTED` until the pending effect is verified/resolved.

## Credential architecture

Long-lived provider secrets stay behind a tenant-bound connector/credential broker.

Workers receive narrow task capabilities where possible.

Reader workloads do not inherit writer credentials.

No raw secrets in:
- prompts,
- Git,
- Obsidian,
- worker messages,
- model traces.

## Egress

Every privileged runtime has an explicit egress policy.

Default deny for writer sandboxes where practical; allow only provider/domain endpoints required by the delegated capability.

The exact enforcement technology is an implementation choice, but passing the egress acceptance tests is mandatory.

## Supply chain

Tools/MCP/skills/packages require approved identity/version.

Pin versions/hashes where possible.

Untrusted tool metadata cannot expand authority.

## PII / erasure

Raw customer PII is kept in deletable tenant-scoped stores.

Immutable audit/receipt data references opaque `subject_ref` values.

Deletion must withdraw:
- canonical identifiable rows,
- evidence copies where deletable,
- vectors,
- FTS entries,
- caches,
- derived summaries/procedures if they expose the subject.

Only non-identifying audit proof remains unless legal hold applies.

## DBOS / database separation

V1 may use one Postgres cluster, but MUST separate:
- AgencyOS control/business schemas/roles;
- DBOS workflow/system schema/role.

Recovery cannot reactivate writers until workflow state and external effects have been reconciled.

## High-risk classes

Credential/permission/security changes, material financial/commercial commitments and other T4 actions require:
- exact proposal;
- current policy;
- owner step-up MFA;
- receipt.

No second human required in V1.
