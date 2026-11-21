-- Phase 2 fixes: alerts raised from unusual-activity flags, and editable projection assumptions.
CREATE TABLE flag_alerts (id INTEGER PRIMARY KEY, flag_id INTEGER NOT NULL, user_id INTEGER NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, sent_at INTEGER NOT NULL, read_at INTEGER);
CREATE INDEX flag_alerts_user ON flag_alerts (user_id, sent_at);

-- Assumed values behind the risk projection and the simulator. Placeholders until real history replaces them.
INSERT INTO settings VALUES ('assumptions', '{"rates_30d":{"hopper":6,"tear":4,"wrap":1.5,"starve":5,"block":1,"cell":3,"bearing":0.3,"jam":1.2},"ttf_min":{"bearing":60,"wrap":30,"block":45,"jam":20},"early_catch":0.98,"bearing_age_days":150}');
