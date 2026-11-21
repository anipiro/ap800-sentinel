-- Phase 2: stored simulation runs and unusual-activity flags.
-- Simulation runs live only here. They never write to issues, events, notifications or actions of the real database.
CREATE TABLE simulations (id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, created_by TEXT, scenario TEXT NOT NULL, params TEXT NOT NULL,
  detect_min REAL, loss_early REAL, loss_late REAL, loss_never REAL, result TEXT NOT NULL);
CREATE INDEX simulations_time ON simulations (created_at);

CREATE TABLE unusual_flags (id INTEGER PRIMARY KEY, machine_id INTEGER NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, severity TEXT NOT NULL,
  title TEXT NOT NULL, explanation TEXT NOT NULL, data TEXT, verdict TEXT, verdict_by TEXT, verdict_at INTEGER);
CREATE INDEX unusual_machine_ts ON unusual_flags (machine_id, ts, kind);
