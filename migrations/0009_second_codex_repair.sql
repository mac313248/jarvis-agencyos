-- 0009_second_codex_repair.sql
-- Finding 2: DB-enforced inbound authenticity invariant. canonical_events
-- must reject any row where materialized_state = true AND authenticity_status
-- IN ('FAILED','UNKNOWN'). VERIFIED and NOT_APPLICABLE remain eligible per the
-- existing application rule. Enforced at the DB so direct runtime SQL cannot
-- bypass it.
ALTER TABLE canonical_events
  ADD CONSTRAINT canonical_events_no_materialize_on_failed_auth
  CHECK (NOT (materialized_state = true AND authenticity_status IN ('FAILED','UNKNOWN')));

-- Finding 3: match canonical session-id types. 06_SYSTEM_CONTRACTS.md defines
-- OwnerAuthContext.session_id and ApprovalDecision.owner_auth_session_id as
-- `string` (not uuid). Align the persisted columns so non-UUID string session
-- IDs (e.g. "owner-session-test-001") are honored exactly.
ALTER TABLE owner_sessions ALTER COLUMN session_id TYPE text USING session_id::text;
ALTER TABLE approval_decisions ALTER COLUMN owner_auth_session_id TYPE text USING owner_auth_session_id::text;
