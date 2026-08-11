-- 0018_observability_receipt_trace_fks.sql
-- F-12R: database-enforced tenant-aware receipt ↔ trace ↔ attention integrity.
-- Bound to 01_ARCHITECTURE_LOCKS.md (tenant-aware FKs) and
-- 06_SYSTEM_CONTRACTS.md ExecutionReceipt.trace_id.
--
-- Composite FKs require matching UNIQUE targets. Primary keys alone are not
-- sufficient for (tenant_id, id) references that reject cross-tenant links.

ALTER TABLE execution_traces
  ADD CONSTRAINT execution_traces_tenant_trace_unique
  UNIQUE (tenant_id, trace_id);

ALTER TABLE execution_receipts
  ADD CONSTRAINT execution_receipts_tenant_receipt_unique
  UNIQUE (tenant_id, receipt_id);

ALTER TABLE execution_receipts
  ADD CONSTRAINT execution_receipts_trace_tenant_fkey
  FOREIGN KEY (tenant_id, trace_id)
  REFERENCES execution_traces (tenant_id, trace_id);

ALTER TABLE attention_items
  ADD CONSTRAINT attention_items_trace_tenant_fkey
  FOREIGN KEY (tenant_id, trace_id)
  REFERENCES execution_traces (tenant_id, trace_id);

ALTER TABLE attention_items
  ADD CONSTRAINT attention_items_receipt_tenant_fkey
  FOREIGN KEY (tenant_id, receipt_id)
  REFERENCES execution_receipts (tenant_id, receipt_id);
