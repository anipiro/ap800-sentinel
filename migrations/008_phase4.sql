-- Phase 4: model monitoring, issue feedback, report sends, webhook.
CREATE TABLE model_stats (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, model_version_id INTEGER, samples INTEGER NOT NULL, drift REAL NOT NULL, worst_signal TEXT, mean_score REAL, detail TEXT);
CREATE INDEX model_stats_ts ON model_stats (ts);
CREATE TABLE issue_feedback (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL, verdict TEXT NOT NULL CHECK (verdict IN ('real', 'false_alarm')), by_name TEXT, ts INTEGER NOT NULL);
CREATE INDEX issue_feedback_issue ON issue_feedback (issue_id);
CREATE TABLE report_sends (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, period TEXT NOT NULL, recipients TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, by_name TEXT);
CREATE TABLE webhook_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, issue_id INTEGER, url TEXT NOT NULL, status TEXT NOT NULL);
INSERT INTO settings VALUES ('drift_threshold', '2'), ('webhook_url', '');
