# V1.0A Read-Safe Foundation — Acceptance Map

| Gate | Status | Evidence |
|---|---|---|
| Tenant/RLS boundary (#1–#6) | PASS | `tests/rls-negative.test.mjs` + `tests/postgres-multiprocess-boundary.test.mjs` |
| Missing tenant context (#3) | PASS | RLS + real Postgres multiprocess |
| Inbound authenticity (#15–#20) | PASS | `tests/inbound-authenticity-gate.test.mjs` |
| Read provenance/freshness (#39–#42) | PASS | `tests/reconciliation.test.mjs` |
| Privacy/confidentiality reads (#40–#43, #47 structural) | PASS | `tests/security-privacy-acceptance.test.mjs`, `tests/connector-registry.test.mjs` |
| Connector/capability read foundation | PASS | `tests/capability-registry.test.mjs`, `tests/connector-registry.test.mjs` |
| Builder regression (#48–#55) | PASS | builder-stage1 suite + CI gate |
| Real multi-process PostgreSQL | PASS | `artifacts/v1.0a/postgres-boundary-verification.txt` |

Business-write autonomy: DISABLED
