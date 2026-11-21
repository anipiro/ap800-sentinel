-- Cross-check between the activity monitor and the fault model.
-- An issue can carry its own display title, e.g. "Possible sensor fault: check the filling pressure sensor".
ALTER TABLE issues ADD COLUMN title TEXT;
