# 05 — PRODUCT BEHAVIOR

## Jarvis

Jarvis is the owner-facing Chief of Staff.

Default briefing:

**Changed → Needs You → Risks / Unknowns → Completed → Evidence**

No material delta = silence, except non-silenceable classes defined by policy.

## Briefing integrity / hostile content

Owner-facing briefing claims must be generated from typed, evidence-backed records.

Content originating from untrusted sources such as:
- customer messages,
- email,
- webpages,
- documents,
- tool output,
- retrieved memory,
- model output

must retain provenance/trust metadata.

When untrusted text itself matters, Jarvis presents it as attributed/quoted content, not as a trusted instruction or unexplained system fact.

A briefing cannot create authority.

## Owner controls

`ADD_CONTEXT`
`STEER_NEXT`
`PAUSE`
`APPROVE`
`REJECT`
`STOP`
`RESUME`

Inspection is passive.

`APPROVE` / `REJECT` applies only to the exact proposal shown to the owner and is bound to:
- `proposal_id`,
- canonical `request_hash`,
- current relevant state/version,
- authenticated owner session,
- step-up MFA when policy requires.

## Owner authentication

High-risk approvals require a recent step-up MFA.

V1 has one human root of trust: the owner.
No mandatory second approver.

## Agent 0

Agent 0 is the tenant-bound logical business operator.

Core loop:

`EVENT`
→ refresh/reconcile current state
→ single-flight subject/routine decision
→ gather minimum context
→ propose
→ deterministic policy/risk
→ execute if authorized
→ verify
→ receipt
→ update state
→ evaluate/escalate

## Agent 0 autonomy

| Level | Behavior |
|---|---|
| T0 | observe |
| T1 | recommend/draft |
| T2 | structured low-risk reversible/pre-authorized work |
| T3 | customer-facing action inside approved routine |
| T4 | commercial/high-risk action only under explicit grant/cap + owner step-up MFA where required |
| T5 | prohibited/owner-only |

Price changes, discounts, refunds, contracts, credentials, security/permission changes and uncapped spend never become routine authority accidentally.

## Agent 0 single-flight

For customer-facing decisioning, only one active decision workflow may exist for the same:

`tenant_id + subject_ref + routine_id + logical_stage`

Additional events update/queue behind that workflow rather than spawning competing decisions.

## Cross-business confidentiality

Jarvis may synthesize across the owner's first-party businesses.

Outside customer/client tenants remain isolated:
- no raw cross-client context;
- no client A content influencing client B customer-facing output;
- no cross-client global durable memory.

## Deletion behavior

If a customer data deletion request is valid:
- identifiable data is removed from canonical and derived stores;
- vectors/FTS/cache/derived summaries are withdrawn/rebuilt;
- raw PII is not preserved inside immutable receipt payloads;
- only non-identifying audit proof remains unless legally required retention applies.
