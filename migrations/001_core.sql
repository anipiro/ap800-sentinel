-- Phase 1 core schema
CREATE TABLE machines (id INTEGER PRIMARY KEY, name TEXT NOT NULL, model TEXT, installed_at TEXT, target_kg_h REAL);
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('operator','technician','manager')), shift TEXT NOT NULL DEFAULT 'any', telegram_id TEXT);
CREATE TABLE responsibilities (machine_id INTEGER NOT NULL, user_id INTEGER NOT NULL, level INTEGER NOT NULL);

CREATE TABLE readings (ts INTEGER NOT NULL, machine_id INTEGER NOT NULL, data TEXT NOT NULL, anomaly INTEGER NOT NULL DEFAULT 0, score REAL);
CREATE INDEX readings_machine_ts ON readings (machine_id, ts);

CREATE TABLE model_versions (id INTEGER PRIMARY KEY, trained_at TEXT NOT NULL, metrics TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0);

CREATE TABLE issues (
  id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL, component TEXT, type TEXT NOT NULL, severity TEXT NOT NULL,
  confidence REAL, fail_prob REAL, rul_min REAL, explanation TEXT, model_version_id INTEGER,
  status TEXT NOT NULL DEFAULT 'detected', is_simulated INTEGER NOT NULL DEFAULT 0,
  detected_at INTEGER NOT NULL, notified_at INTEGER, acked_at INTEGER, acked_by INTEGER, action_at INTEGER,
  resolved_at INTEGER, resolved_by TEXT, verified_at INTEGER, verified_by INTEGER, resolution TEXT,
  downtime_h REAL NOT NULL DEFAULT 0, scrap_kg REAL NOT NULL DEFAULT 0,
  actual_loss REAL NOT NULL DEFAULT 0, projected_loss REAL NOT NULL DEFAULT 0, savings REAL NOT NULL DEFAULT 0
);
CREATE INDEX issues_machine_time ON issues (machine_id, detected_at);

CREATE TABLE notifications (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL, user_id INTEGER NOT NULL, channel TEXT NOT NULL, level INTEGER NOT NULL,
  status TEXT NOT NULL, sent_at INTEGER NOT NULL, delivered_at INTEGER, acked_at INTEGER);
CREATE INDEX notifications_user ON notifications (user_id, sent_at);

CREATE TABLE actions (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL, machine_id INTEGER NOT NULL, kind TEXT NOT NULL, risk TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT, confidence REAL, created_at INTEGER NOT NULL, decided_at INTEGER, decided_by INTEGER, executed_at INTEGER, reverted_at INTEGER);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE cost_params (machine_id INTEGER PRIMARY KEY, production_value_h REAL, idle_labour_h REAL, repair_labour_h REAL, scrap_kg REAL, energy_kwh REAL, currency TEXT);

-- History: append-only. Corrections are new rows.
CREATE TABLE events (id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, actor_type TEXT NOT NULL, actor TEXT,
  issue_id INTEGER, ref_table TEXT, ref_id INTEGER, summary TEXT NOT NULL, data TEXT, is_simulated INTEGER NOT NULL DEFAULT 0);
CREATE INDEX events_machine_ts_type ON events (machine_id, ts, type);
CREATE INDEX events_issue ON events (issue_id);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, user_id INTEGER, action TEXT NOT NULL, detail TEXT);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Seed: one real machine, demo people, placeholder costs (example values, not real figures)
INSERT INTO machines VALUES (1, 'Dumpling line 1', 'Signal-Pack AP800', '2024-09-01', 495);
INSERT INTO users (id, name, role, shift) VALUES
  (1, 'Nino (operator)', 'operator', 'any'),
  (2, 'Giorgi (technician, day shift)', 'technician', 'day'),
  (3, 'Luka (technician, night shift)', 'technician', 'night'),
  (4, 'Tamar (maintenance lead)', 'technician', 'any'),
  (5, 'Mariam (production manager)', 'manager', 'any');
INSERT INTO responsibilities VALUES (1, 2, 1), (1, 3, 1), (1, 4, 2), (1, 5, 3);
INSERT INTO cost_params VALUES (1, 3000, 40, 30, 4, 0.25, 'GEL');
INSERT INTO settings VALUES ('automation_enabled', '1'), ('approval_stop_feed', '1'), ('approval_safe_shutdown', '1');
