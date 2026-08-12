# 11 — TEMPLATE & ONBOARDING

## Product layers

### JARVIS CORE
Shared product/control-plane code.

### OWNER PACK
Owner preferences/memberships.
No tenant raw data or credentials.

### BUSINESS PACK
Versioned reusable routines, schemas, connector requirements, policy templates and evals.

### TENANT DATA
Private Postgres/object-storage state.
Never copied into a template.

### CONNECTORS
Tenant-specific account/resource bindings and credential refs.

### POLICIES
Versioned definitions + tenant-specific grants/caps.

### SPECIALISTS
Versioned contracts activated only when justified.

## Confidentiality classes

Each tenant declares:

`FIRST_PARTY_PORTFOLIO` or `THIRD_PARTY_ISOLATED`.

Cross-business owner synthesis is permitted only according to that classification and explicit owner access.

Agency/reseller commercial relationship does not automatically grant end-tenant raw-data access.

## Provisioning

`REQUESTED`
→ create authenticated owner/memberships
→ create deny-all tenant
→ assign confidentiality class
→ pin Business Pack
→ create RLS-protected storage
→ provision control state; provision DBOS workflow state only where selected workflows require it
→ authorize connectors
→ verify connector resource ownership
→ read-only sync
→ enable T0/T1 only after read-path isolation/authenticity/privacy gates pass
→ reconcile mappings
→ configure grants/budgets
→ run isolation + inbound-auth tests
→ run deletion/privacy tests
→ sandbox/shadow eval
→ activate only approved autonomy
→ LIVE

No writes before gates pass.

## Outside customer

Outside customers are `THIRD_PARTY_ISOLATED` by default.

They cannot influence another outside tenant's context/output.

## Upgrade

Tenant behavior is pinned to pack/procedure/policy/SOT versions.

Updates require explicit migration/eval/activation.

## Offboarding / deletion

1. disable tenant and writes;
2. revoke memberships/delegations;
3. revoke task/workflow/connector capabilities;
4. export if required;
5. delete identifiable online data/derived indexes according to policy;
6. retain only allowed non-identifying audit tombstones;
7. verify external write authority is zero.

## SOT cloning rule

Do not clone a “working Jarvis.”

Provision from the versioned template and exact SOT contracts.
