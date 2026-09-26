-- Cross-Merchant Procurement Agent — initial schema.
-- Portable SQL subset: runs on SQLite (node:sqlite) and PostgreSQL.
-- Monetary amounts: integer minor units with explicit currency columns.
-- Timestamps: RFC 3339 strings (TEXT) to keep both engines identical.
-- JSON: TEXT columns holding canonical JSON documents.

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buyers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  can_purchase INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cost_centers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  allocated_minor BIGINT NOT NULL,
  committed_minor BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS procurement_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  buyer_id TEXT NOT NULL REFERENCES buyers(id),
  cost_center_id TEXT NOT NULL,
  product_constraints_json TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  delivery_deadline TEXT NOT NULL,
  currency TEXT NOT NULL,
  budget_minor BIGINT NOT NULL,
  destination_id TEXT NOT NULL,
  allowed_merchants_json TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  intent_json TEXT,
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  selected_quote_id TEXT,
  simulation_json TEXT NOT NULL DEFAULT '{}',
  source_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_org ON procurement_requests(organization_id, created_at);

CREATE TABLE IF NOT EXISTS supplier_tasks (
  id TEXT PRIMARY KEY,
  procurement_request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  supplier_id TEXT NOT NULL,
  a2a_task_id TEXT,
  a2a_context_id TEXT,
  native_status TEXT NOT NULL,
  deadline TEXT NOT NULL,
  last_event_at TEXT,
  artifact_reference TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_tasks_request ON supplier_tasks(procurement_request_id);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  supplier_task_id TEXT NOT NULL REFERENCES supplier_tasks(id),
  procurement_request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  supplier_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  native_quote_id TEXT NOT NULL,
  items_json TEXT NOT NULL,
  subtotal_minor BIGINT NOT NULL,
  tax_minor BIGINT NOT NULL,
  shipping_minor BIGINT NOT NULL,
  total_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  delivery_date TEXT,
  expires_at TEXT NOT NULL,
  quantity_available INTEGER NOT NULL,
  eligibility_json TEXT,
  ranking_json TEXT,
  artifact_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quotes_request ON quotes(procurement_request_id);

CREATE TABLE IF NOT EXISTS checkout_attempts (
  id TEXT PRIMARY KEY,
  procurement_request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  merchant_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  native_checkout_id TEXT NOT NULL,
  native_order_id TEXT,
  native_status TEXT,
  approved_snapshot_digest TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  completion_state TEXT NOT NULL,
  payment_state TEXT NOT NULL,
  capability_snapshot_json TEXT,
  checkout_view_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  last_error TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_request ON checkout_attempts(procurement_request_id);
CREATE INDEX IF NOT EXISTS idx_attempts_state ON checkout_attempts(completion_state);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  procurement_request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  checkout_attempt_id TEXT NOT NULL REFERENCES checkout_attempts(id),
  actor_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  auth_context_json TEXT NOT NULL,
  state TEXT NOT NULL,
  invalidation_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_request ON approvals(procurement_request_id, state);

CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  cost_center_id TEXT NOT NULL REFERENCES cost_centers(id),
  procurement_request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  execution_reference TEXT NOT NULL UNIQUE,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_cc ON budget_reservations(cost_center_id, state);

CREATE TABLE IF NOT EXISTS protocol_events (
  id TEXT PRIMARY KEY,
  procurement_request_id TEXT,
  trace_id TEXT NOT NULL,
  protocol TEXT NOT NULL,
  direction TEXT NOT NULL,
  operation TEXT NOT NULL,
  version TEXT,
  counterparty TEXT,
  status TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_protocol_events_request ON protocol_events(procurement_request_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  procurement_request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_request ON workflow_events(procurement_request_id, created_at);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  procurement_request_id TEXT NOT NULL UNIQUE REFERENCES procurement_requests(id),
  checkout_attempt_id TEXT NOT NULL REFERENCES checkout_attempts(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  order_references_json TEXT NOT NULL,
  payment_evidence_json TEXT NOT NULL,
  final_totals_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Transactional outbox: written in the same transaction as the state change it announces.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  completed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(completed_at, available_at);
-- One live execution per attempt: prevents duplicate execute_checkout messages.
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_kind_aggregate ON outbox(kind, aggregate_id);

-- Application API idempotency (scope = buyer + route).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idem_key)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
