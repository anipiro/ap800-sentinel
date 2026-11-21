// Financial loss formulas. One place, pure functions, unit-tested in test/loss.test.js.
//
// Cost parameters (per machine, table cost_params):
//   production_value_h  value of one hour of production
//   idle_labour_h       cost of the line crew standing idle for one hour
//   repair_labour_h     technician cost per repair hour
//   scrap_kg            cost of one kg of scrapped product
//   energy_kwh          energy price per kWh
//
// Actual loss       = downtime hours × (lost production value + idle labour cost) + repair cost + scrap cost + extra energy cost
// Projected loss    = failure probability × cost of failure (including expected downtime)
// Savings           = projected failure cost − preventive repair cost

const round2 = (x) => Math.round(x * 100) / 100;

function repairCost({ repair_h = 0, parts = 0 }, c) { return repair_h * c.repair_labour_h + parts; }

function actualLoss({ downtime_h = 0, repair_h = 0, parts = 0, scrap_kg = 0, extra_kwh = 0 }, c) {
  const downtime = downtime_h * (c.production_value_h + c.idle_labour_h);
  const repair = repairCost({ repair_h, parts }, c);
  const scrap = scrap_kg * c.scrap_kg;
  const energy = extra_kwh * c.energy_kwh;
  return { downtime: round2(downtime), repair: round2(repair), scrap: round2(scrap), energy: round2(energy), total: round2(downtime + repair + scrap + energy) };
}

// Cost of an event described by expected downtime, repair hours and parts (a failure, or a planned repair).
function eventCost(spec, c) { return round2(spec.downtime_h * (c.production_value_h + c.idle_labour_h) + repairCost(spec, c)); }

function projectedLoss(failProb, failureSpec, c) { return round2(Math.max(0, Math.min(1, failProb)) * eventCost(failureSpec, c)); }

function savingsFromEarlyDetection(failureSpec, preventiveSpec, c) { return round2(Math.max(0, eventCost(failureSpec, c) - eventCost(preventiveSpec, c))); }

// Return on the monitoring module for a period: (savings − losses still incurred on caught issues) ÷ module cost.
function roi(totalSavings, moduleCost) { return moduleCost > 0 ? round2(totalSavings / moduleCost) : null; }

module.exports = { actualLoss, eventCost, repairCost, projectedLoss, savingsFromEarlyDetection, roi, round2 };
