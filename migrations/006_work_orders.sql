-- Phase 3: work orders with a lifecycle, and the root-cause knowledge base.
CREATE TABLE work_orders (id INTEGER PRIMARY KEY, issue_id INTEGER, machine_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','assigned','in_progress','completed','verified')),
  assigned_to INTEGER, duration_h REAL NOT NULL, window_start INTEGER, window_end INTEGER, window_reason TEXT, in_peak INTEGER NOT NULL DEFAULT 0, deadline INTEGER,
  notes TEXT, created_at INTEGER NOT NULL, assigned_at INTEGER, started_at INTEGER, completed_at INTEGER, verified_at INTEGER, verified_by INTEGER);
CREATE INDEX work_orders_issue ON work_orders (issue_id);
CREATE INDEX work_orders_status ON work_orders (status, window_start);

CREATE TABLE kb_entries (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, root_cause TEXT NOT NULL, fix TEXT NOT NULL,
  parts TEXT, minutes REAL, recorded_by TEXT, created_at INTEGER NOT NULL);
CREATE INDEX kb_type ON kb_entries (type, created_at);
