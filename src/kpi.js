// KPIs from recorded readings and issues. Read-only.
//   OEE = availability × performance × quality
//   availability = time producing ÷ time recorded          (producing = output above 100 kg/h)
//   performance  = average output while producing ÷ target output, capped at 100 %
//   quality      = 1 − average defect rate while producing
//   MTBF = producing hours ÷ machine faults      MTTR = average time from detection to repair, for faults fixed by people
// Hours are production hours on the demo clock (one recorded second = timeScale seconds of production).
const PERIODS = { '1h': 3600000, '24h': 24 * 3600000, '7d': 7 * 24 * 3600000 };
const r3 = (x) => (x === null ? null : Math.round(x * 1000) / 1000);

function kpis(db, { period = '24h', now = Date.now(), timeScale = 60, target = 495 } = {}) {
  const since = now - (PERIODS[period] || PERIODS['24h']);
  const rd = db.prepare(`SELECT COUNT(*) n, SUM(rate > 100) running, AVG(CASE WHEN rate > 100 THEN rate END) avg_rate, AVG(CASE WHEN rate > 100 THEN defect END) avg_defect
    FROM (SELECT CAST(json_extract(data, '$.rate') AS REAL) rate, CAST(json_extract(data, '$.defect') AS REAL) defect FROM readings WHERE machine_id = 1 AND ts >= ?)`).get(since);
  const stops = db.prepare(`SELECT COUNT(*) n FROM (SELECT CAST(json_extract(data, '$.rate') AS REAL) rate, LAG(CAST(json_extract(data, '$.rate') AS REAL)) OVER (ORDER BY ts) prev FROM readings WHERE machine_id = 1 AND ts >= ?) WHERE rate <= 100 AND prev > 100`).get(since).n;
  const n = rd.n || 0, running = rd.running || 0, toH = (sec) => (sec * timeScale) / 3600;
  const availability = n ? running / n : null;
  const performance = running ? Math.min(1, rd.avg_rate / target) : null;
  const quality = running ? Math.max(0, 1 - rd.avg_defect / 100) : null;
  const oee = availability !== null && performance !== null && quality !== null ? availability * performance * quality : null;
  const faults = db.prepare("SELECT COUNT(*) n FROM issues WHERE detected_at >= ? AND type NOT IN ('sensor')").get(since).n;
  const fix = db.prepare("SELECT AVG(resolved_at - detected_at) ms, COUNT(*) n FROM issues WHERE detected_at >= ? AND resolved_at IS NOT NULL AND resolved_by <> 'system'").get(since);
  return {
    period, recorded_h: r3(toH(n)), producing_h: r3(toH(running)), downtime_h: r3(toH(n - running)), unplanned_stops: stops,
    availability: r3(availability), performance: r3(performance), quality: r3(quality), oee: r3(oee),
    faults, mtbf_h: faults ? r3(toH(running) / faults) : null, repairs: fix.n, mttr_h: fix.n ? r3((fix.ms / 1000) * timeScale / 3600) : null,
  };
}

module.exports = { kpis, PERIODS };
