# 06 — SYSTEM CONTRACTS

**THIS FILE IS THE SINGLE CANONICAL AGENCYOS BUSINESS-RUNTIME CONTRACT/SCHEMA AUTHORITY.**

All AgencyOS business-runtime code, migrations, tests and other SOT files reference the versioned contracts defined here.

Builder Core Stage-1 internal contracts are already frozen in implemented Builder code/evidence and are intentionally not duplicated here; only the trust-domain boundary is shared.

## Contract versioning

Every machine contract has:
- `contract_name`
- `contract_version`
- schema file in Git
- immutable Git SHA for a release
- backward/forward compatibility declaration where relevant.

Running workflows pin contract versions.

## ContextEnvelope

```yaml
contract_version: 1
request_id: uuid
principal_id: string
authorized_tenant_ids: [uuid]
active_tenant_id: uuid|null
tenant_confidentiality_class: FIRST_PARTY_PORTFOLIO|THIRD_PARTY_ISOLATED|null
context_source: explicit_selector|explicit_language|unique_entity|recent_explicit_context|portfolio
cross_tenant: boolean
context_epoch: integer
confidence: exact|high|ambiguous
```

Material writes require exact tenant resolution.

## OwnerAuthContext

```yaml
contract_version: 1
owner_principal_id: string
session_id: string
auth_strength: standard|step_up_mfa
authenticated_at: timestamp
step_up_verified_at: timestamp|null
step_up_expires_at: timestamp|null
session_expires_at: timestamp
revoked_at: timestamp|null
```

High-risk approval requires `auth_strength=step_up_mfa` and unexpired step-up.

## AuthorityGrant

```yaml
contract_version: 1
grant_id: uuid
tenant_id: uuid
principal: string
capability_action_scope: object
resource_scope: object
risk_ceiling: string
spend_cap: number|null
commitment_cap: object|null
approval_mode: string
effective_at: timestamp
expires_at: timestamp|null
issued_by: string
policy_version: string
revocation_epoch: integer
status: active|expired|revoked|superseded
```

## ActionProposal

```yaml
contract_version: 1
proposal_id: uuid
tenant_id: uuid
workflow_id: uuid
step_id: string
actor: string
capability_id: string
target_ref: string
canonical_request: object
request_hash: sha256
precondition_snapshot_ref: string|null
risk_class: string
reversibility: reversible|compensatable|irreversible
financial_amount: number|null
commitment_class: string|null
created_at: timestamp
expires_at: timestamp|null
```

## ApprovalDecision

```yaml
contract_version: 1
approval_id: uuid
proposal_id: uuid
request_hash: sha256
tenant_id: uuid
owner_principal_id: string
owner_auth_session_id: string
step_up_mfa_required: boolean
decision: APPROVE|REJECT
relevant_state_version: string|null
policy_version: string
decided_at: timestamp
expires_at: timestamp|null
consumed_at: timestamp|null
```

An approval is invalid if proposal/request/state binding no longer matches.

## PolicyDecision

```yaml
contract_version: 1
decision_id: uuid
tenant_id: uuid
proposal_id: uuid
applicable_grants: [uuid]
policy_version: string
verdict: ALLOW|APPROVAL_REQUIRED|DENY
reason_codes: [string]
effective_caps: object
revocation_epoch_checked: integer
kill_epoch_checked: integer
decided_at: timestamp
```

## Capability

```yaml
contract_version: 1
capability_id: string
tenant_scope: string
provider: string
control_surface: api|mcp|cli|dom|browser_agent|computer_use|human
adapter: string
operation: string
risk_class: string
reversibility: reversible|compensatable|irreversible
auth_scope: object
credential_ref: opaque_ref|null
provider_idempotency: supported|unsupported|unknown
postcondition_observable: boolean
preconditions: object
postcondition_verifier: string|null
fallback_routes: [string]
approval_policy: string
network_scope: object
timeout_retry_policy: object
receipt_schema: string
status: active|degraded|disabled
```

If `provider_idempotency != supported` AND `postcondition_observable=false`:
- autonomous retry/replay is forbidden after an ambiguous outcome;
- the action is at least `APPROVAL_REQUIRED`;
- ambiguous completion escalates to human/blocked.

## Deterministic idempotency key

For a material external effect:

`idempotency_key = SHA256(tenant_id || workflow_id || step_id || capability_id || request_hash)`

The same logical workflow step/request MUST produce the same key after process restart or PITR recovery.

## CanonicalEvent

```yaml
contract_version: 1
event_id: uuid
tenant_id: uuid
event_type: string
source_system: string
source_connection_id: uuid|null
source_event_id: string|null
occurred_at: timestamp|null
received_at: timestamp
subject_refs: [string]
typed_properties: object
dedupe_key: string
evidence_ref: string|null
schema_version: integer
origin_class: EXTERNAL|TRUSTED_INTERNAL
authenticity_status: VERIFIED|NOT_APPLICABLE|FAILED|UNKNOWN
authenticity_method: string|null
content_trust: TRUSTED_STRUCTURED|UNTRUSTED_PAYLOAD
verification_evidence_ref: string|null
internal_provenance_ref: string|null
```

Rules:
- `EXTERNAL` events require `authenticity_status=VERIFIED` from the trusted connector/verifier boundary before canonical materialization.
- If origin is unknown, unclassified, ambiguous, or not positively proven internal, treat it as external and fail closed until verified.
- `NOT_APPLICABLE` is valid only when `origin_class=TRUSTED_INTERNAL` and `internal_provenance_ref` points to provenance produced/enforced by trusted infrastructure.
- Caller-supplied connector identity, event type, authenticity status, `trusted/internal` flag, or equivalent payload metadata cannot establish `origin_class=TRUSTED_INTERNAL` or authenticity.
- `FAILED`/`UNKNOWN` authenticity cannot mutate canonical business state. It may create a security/source-health event.
- Authenticated origin does not make payload text semantically trusted.

## CurrentStateRecord

Required fields:

```yaml
contract_version: 1
tenant_id: uuid
state_key: string
domain: string
subject_ref: string
value: object
state_version: string
source_system: string
as_of: timestamp
observed_at: timestamp
verified_at: timestamp|null
max_age_seconds: integer
freshness: FRESH|AGING|STALE|OFFLINE|CONFLICTED|UNKNOWN
conflict_status: NONE|PENDING_LOCAL_EFFECT|SOURCE_CONFLICT|UNKNOWN
last_event_id: uuid|null
evidence_refs: [string]
```

## AttentionItem

Includes:
- tenant/scope,
- condition key,
- state hash,
- severity,
- owner action required,
- first opened,
- last material change,
- ack/snooze/resolved state,
- non-silenceable flag,
- source/evidence refs.

## DelegationContract

Binds:
- root/parent/task/trace IDs,
- tenant,
- specialist template/version/Git SHA,
- objective,
- trusted/untrusted context refs,
- authority grant,
- allowed/denied tools,
- resource ownership/leases,
- budgets/deadline,
- acceptance criteria,
- required artifacts/evidence,
- review requirement,
- cancellation epoch,
- contract/SOT manifest hash.

Natural language cannot alter control fields.

## WorkerResult

Contains:
- task/tenant/specialist identity,
- status claim,
- summary,
- acceptance results,
- result claims + evidence,
- changes/artifacts,
- uncertainties/blockers,
- cost,
- completion claim,
- verification state,
- cleanup/lease state,
- provenance.

Worker `status=succeeded` is not authoritative.

## ExecutionReceipt

```yaml
contract_version: 1
receipt_id: uuid
tenant_id: uuid
workflow_id: uuid
step_id: string
actor: string
capability_id: string
provider: string
operation: string
target_ref: string
subject_ref: string|null
idempotency_key: string
request_hash: string
precondition_snapshot_ref: string|null
authority_decision_ref: uuid
approval_ref: uuid|null
revocation_epoch_at_commit: integer
kill_epoch_at_commit: integer
started_at: timestamp
committed_at: timestamp|null
provider_request_id: string|null
raw_evidence_ref: string|null
postcondition_verifier: string|null
verification_status: VERIFIED|UNVERIFIED|AMBIGUOUS|FAILED
observed_external_version: string|null
state_delta_ref: string|null
error_class: string|null
retry_count: integer
trace_id: uuid
```

Receipts MUST NOT contain raw customer PII when an opaque subject reference is sufficient.

## PII subject reference

```yaml
contract_version: 1
subject_ref: opaque_uuid
tenant_id: uuid
pii_store_ref: opaque_ref
status: active|deleted|legal_hold
created_at: timestamp
deleted_at: timestamp|null
```

Immutable/audit records reference `subject_ref`, not raw PII.

Derived vectors/summaries must retain lineage to deletable source records.

## ModelProfile / RouteDecision

Model routing records:
- profile/provider/model/router/version;
- task/risk/privacy eligibility;
- eval version/results;
- budget/cost;
- provider health;
- fallbacks.

Primary optimization metric: cost per verified successful outcome.

## SOTBuildBinding

Every build/run records:

```yaml
sot_manifest_sha256: string
git_commit_sha: string|null
builder_runtime: string
reviewer_runtime: string|null
created_at: timestamp
```

Production build/test reports are invalid if the SOT manifest is not the approved manifest.
