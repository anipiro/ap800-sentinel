// Simulated AP800 signals. Used by the live engine and by the synthetic training-data generator.
const SIG = {
  cur_feed:  { label: 'Feeder current',              short: 'Current',   unit: 'A',    base: 1.1,  noise: 0.03,  dp: 2 },
  cur_r12:   { label: 'Rollers 1–2 current',         short: 'Current',   unit: 'A',    base: 2.4,  noise: 0.05,  dp: 2 },
  cur_r3:    { label: '3-roller groups current',     short: 'Current',   unit: 'A',    base: 2.8,  noise: 0.05,  dp: 2 },
  cur_cal:   { label: 'Calibrating rollers current', short: 'Current',   unit: 'A',    base: 2.0,  noise: 0.04,  dp: 2 },
  cur_drum:  { label: 'Drum drive current',          short: 'Current',   unit: 'A',    base: 3.1,  noise: 0.06,  dp: 2 },
  cur_pump:  { label: 'Pump current',                short: 'Current',   unit: 'A',    base: 3.4,  noise: 0.06,  dp: 2 },
  cur_belt:  { label: 'Belt motor current',          short: 'Current',   unit: 'A',    base: 0.6,  noise: 0.015, dp: 2 },
  press:     { label: 'Filling pressure',            short: 'Pressure',  unit: 'MPa',  base: 0.25, noise: 0.004, dp: 3 },
  thick:     { label: 'Sheet thickness',             short: 'Thickness', unit: 'mm',   base: 0.8,  noise: 0.008, dp: 2 },
  vib_roll:  { label: 'Rolling gearbox vibration',   short: 'Vibration', unit: 'mm/s', base: 1.8,  noise: 0.08,  dp: 2 },
  vib_drum:  { label: 'Drum vibration',              short: 'Vibration', unit: 'mm/s', base: 2.2,  noise: 0.1,   dp: 2 },
  temp_gear: { label: 'Rolling gearbox temperature', short: 'Gearbox',   unit: '°C',   base: 48,   noise: 0.25,  dp: 1 },
  defect:    { label: 'Defect rate',                 short: 'Defects',   unit: '%',    base: 1.2,  noise: 0.35,  dp: 1, floor: 0.5 },
  rate:      { label: 'Output',                      short: 'Output',    unit: 'kg/h', base: 495,  noise: 4,     dp: 0 },
  motion:    { label: 'Belt movement',               short: 'Movement',  unit: '%',    base: 6,    noise: 0.4,   dp: 1 },
};
const KEYS = Object.keys(SIG);

// Each fault returns multipliers / offsets as a function of r(tau) = 1 - exp(-age/tau), age in seconds.
const FAULTS = {
  tear:    { name: 'Dough sheet tears',     fx: (r) => ({ mul: { cur_cal: 1 - 0.55 * r(2), cur_drum: 1 - 0.5 * r(3), rate: 1 - r(4) } }) },
  hopper:  { name: 'Hopper runs empty',     fx: (r) => ({ mul: { cur_feed: 1 - 0.6 * r(3), cur_r12: 1 - 0.55 * r(5), thick: 1 - 0.3 * r(6), cur_r3: 1 - 0.4 * r(8), cur_cal: 1 - 0.4 * r(10), cur_drum: 1 - 0.35 * r(12), rate: 1 - r(12) } }) },
  wrap:    { name: 'Dough wraps a roller',  fx: (r) => ({ mul: { cur_r3: 1 + 0.7 * r(3), vib_roll: 1 + 0.5 * r(3), cur_cal: 1 - 0.5 * r(4), cur_drum: 1 - 0.45 * r(5), rate: 1 - r(5) } }) },
  starve:  { name: 'Filling runs out',      fx: (r) => ({ mul: { press: 1 - 0.7 * r(3), cur_pump: 1 - 0.4 * r(3), rate: 1 - 0.3 * r(5) }, add: { defect: 55 * r(5) } }) },
  block:   { name: 'Filling nozzle blocks', fx: (r) => ({ mul: { press: 1 + 0.7 * r(2), cur_pump: 1 + 0.35 * r(2) }, add: { defect: 40 * r(4) } }) },
  cell:    { name: 'Drum cell clogs',       fx: (r) => ({ mul: { vib_drum: 1 + 0.12 * r(2) }, add: { defect: 9 * r(2) } }) },
  bearing: { name: 'Gearbox bearing wears', fx: (r) => ({ mul: { vib_roll: 1 + 2.2 * r(25) }, add: { temp_gear: 22 * r(40) } }) },
  jam:     { name: 'Exit belt jams',        fx: (r) => ({ mul: { cur_belt: 1 + 1.8 * r(1.5), motion: 1 - r(0.6), rate: 1 - r(3) } }) },
};

function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// One raw sample of every signal. t and age in seconds. stopped = machine halted (drives off).
function sample(t, fault, age, stopped = false) {
  const r = (tau) => 1 - Math.exp(-Math.max(0, age) / tau);
  const fx = fault && FAULTS[fault] ? FAULTS[fault].fx(r) : {};
  const mul = fx.mul || {}, add = fx.add || {};
  const out = {};
  KEYS.forEach((k, i) => {
    const s = SIG[k];
    let v = (s.base * (1 + 0.01 * Math.sin(t / 37 + i)) + gauss() * s.noise) * (mul[k] ?? 1) + (add[k] ?? 0);
    if (stopped) v = k === 'temp_gear' ? s.base - 6 + gauss() * s.noise : k === 'thick' ? s.base + gauss() * s.noise : Math.abs(gauss() * s.noise * 0.5);
    out[k] = Math.max(0, v);
  });
  return out;
}

const smooth = (ew, raw) => { const o = {}; KEYS.forEach((k) => { o[k] = ew ? 0.6 * ew[k] + 0.4 * raw[k] : raw[k]; }); return o; };

module.exports = { SIG, KEYS, FAULTS, sample, smooth, gauss };
