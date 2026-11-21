-- Phase 3: spare parts stock, linked to the issue types that need them. All figures are placeholders.
CREATE TABLE parts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, stock INTEGER NOT NULL, min_stock INTEGER NOT NULL, lead_time_days INTEGER NOT NULL, unit_cost REAL NOT NULL);
CREATE TABLE part_links (part_id INTEGER NOT NULL, issue_type TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1);
CREATE INDEX part_links_type ON part_links (issue_type);

INSERT INTO parts (id, name, stock, min_stock, lead_time_days, unit_cost) VALUES
  (1, 'Gearbox bearing set', 1, 1, 14, 650),
  (2, 'Exit belt', 0, 1, 10, 1100),
  (3, 'Slot nozzle seal kit', 3, 1, 7, 120),
  (4, 'Roller scraper blade', 4, 2, 7, 60),
  (5, 'Drum pusher set', 1, 1, 21, 300),
  (6, 'Filling pressure sensor', 1, 1, 5, 350);
INSERT INTO part_links (part_id, issue_type, qty) VALUES (1, 'bearing', 1), (2, 'jam', 1), (3, 'block', 1), (4, 'wrap', 1), (5, 'cell', 1), (6, 'sensor', 1);
