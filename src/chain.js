// Line chain beyond the forming machine: motor drive (VFD), motor thermistors, thermal camera, blast freezer, packaging.
// All of it is SIMULATED and derived from the forming machine's own simulated signals. None of it is an input to the
// trained fault model, so detection behaves exactly as before; the motor drive current is attached to a diagnosis
// as supporting evidence only.
const { SIG, gauss } = require('./sim');
const unusual = require('./unusual');

// Where every reading would come from on a real line, and what kind of signal it is.
const SOURCES = [
  { key: 'cur_feed',  device: 'Motor drive (VFD), feeder',            protocol: 'Modbus TCP',            type: 'analog' },
  { key: 'cur_r12',   device: 'Motor drive (VFD), rollers 1–2',       protocol: 'Modbus TCP',            type: 'analog' },
  { key: 'cur_r3',    device: 'Motor drive (VFD), 3-roller groups',   protocol: 'Modbus TCP',            type: 'analog' },
  { key: 'cur_cal',   device: 'Motor drive (VFD), calibrating rollers', protocol: 'Modbus TCP',          type: 'analog' },
  { key: 'cur_drum',  device: 'Motor drive (VFD), drums',             protocol: 'Modbus TCP',            type: 'analog' },
  { key: 'cur_pump',  device: 'Motor drive (VFD), filling pump',      protocol: 'Modbus TCP',            type: 'analog' },
  { key: 'cur_belt',  device: 'Motor drive (VFD), exit belt',         protocol: 'Modbus TCP',            type: 'analog' },
  { key: 'press',     device: 'Pressure transmitter',                 protocol: '4–20 mA via PLC',       type: 'analog' },
  { key: 'thick',     device: 'Laser thickness gauge',                protocol: '4–20 mA via PLC',       type: 'analog' },
  { key: 'vib_roll',  device: 'Vibration sensor, rolling gearbox',    protocol: 'IO-Link',               type: 'analog' },
  { key: 'vib_drum',  device: 'Vibration sensor, drum drive',         protocol: 'IO-Link',               type: 'analog' },
  { key: 'temp_gear', device: 'Gearbox PT100',                        protocol: '4–20 mA via PLC',       type: 'analog' },
  { key: 'defect',    device: 'Belt camera',                          protocol: 'Ethernet',              type: 'derived from images' },
  { key: 'motion',    device: 'Belt camera',                          protocol: 'Ethernet',              type: 'derived from images' },
  { key: 'rate',      device: 'Line PLC',                             protocol: 'OPC UA',                type: 'counter' },
  { key: 'vfd_amps',  device: 'Motor drive (VFD), main drive',        protocol: 'Modbus TCP',            type: 'analog',  label: 'Main drive current', unit: 'A' },
  { key: 'vfd_torque', device: 'Motor drive (VFD), main drive',       protocol: 'Modbus TCP',            type: 'analog',  label: 'Main drive torque', unit: '%' },
  { key: 'vfd_speed', device: 'Motor drive (VFD), main drive',        protocol: 'Modbus TCP',            type: 'analog',  label: 'Main drive speed', unit: 'rpm' },
  { key: 'winding',   device: 'Motor PT100, winding',                 protocol: '4–20 mA via PLC',       type: 'analog',  label: 'Motor winding temperature', unit: '°C' },
  { key: 'ptc_trip',  device: 'Motor PTC thermistor',                 protocol: 'Digital input via PLC', type: 'on/off',  label: 'Motor over-temperature trip', unit: '' },
  { key: 'product',   device: 'IR camera, exit belt',                 protocol: 'Ethernet',              type: 'derived from images', label: 'Product temperature on the belt', unit: '°C' },
  { key: 'entry',     device: 'IR camera, freezer infeed',            protocol: 'Ethernet',              type: 'derived from images', label: 'Product temperature at freezer entry', unit: '°C' },
  { key: 'chamber',   device: 'Freezer controller',                   protocol: 'Modbus',                type: 'analog',  label: 'Blast freezer chamber temperature', unit: '°C' },
  { key: 'compressor', device: 'Freezer controller',                  protocol: 'Modbus',                type: 'analog',  label: 'Freezer compressor current', unit: 'A' },
  { key: 'packed',    device: 'Line PLC',                             protocol: 'OPC UA',                type: 'counter', label: 'Packaging output', unit: 'kg/h' },
].map((s) => ({ ...s, label: s.label || SIG[s.key].label, unit: s.unit !== undefined ? s.unit : SIG[s.key].unit, source: `${s.device} — ${s.protocol}`, simulated: true }));

const BASE = { vfd_amps: 6.2, vfd_torque: 62, vfd_speed: 1450, winding: 68, product: 14, chamber: -32, compressor: 38 };
const PTC_TRIP_C = 110, FREEZER_NOMINAL_ENTRY = 15.5, HIST_KEYS = ['vfd_amps', 'vfd_torque', 'vfd_speed', 'winding', 'entry', 'chamber', 'compressor'];
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// One step of the simulated chain. Called from the engine tick; never throws into it.
function step(eng) {
  if (eng.simulated || !eng.ew) return null;
  const A = (eng.aux = eng.aux || { winding: BASE.winding, product: BASE.product, chamber: BASE.chamber, warmTicks: 0, hist: Object.fromEntries(HIST_KEYS.map((k) => [k, []])) });
  const rel = (k) => (eng.ew[k] - SIG[k].base) / SIG[k].base, stopped = eng.stopped;
  // Load on the main drive: a jammed belt, a worn bearing, dough wrapped on a roller or thicker dough all take more current.
  const load = stopped ? 0 : 1 + 0.25 * clip(rel('cur_belt'), 0, 3) + 0.12 * clip(rel('vib_roll'), 0, 3) + 0.3 * clip(rel('cur_r3'), 0, 2) + 1.0 * clip(rel('thick'), -0.3, 0.5);
  A.load = load;
  A.vfd_amps = stopped ? Math.abs(gauss() * 0.02) : BASE.vfd_amps * load + gauss() * 0.05;
  A.vfd_torque = stopped ? 0 : BASE.vfd_torque * load + gauss() * 0.4;
  A.vfd_speed = stopped ? 0 : BASE.vfd_speed * (1 - 0.03 * clip(load - 1, 0, 1)) + gauss() * 2;
  A.winding += ((stopped ? 35 : BASE.winding + 55 * (load - 1)) - A.winding) * 0.04;
  A.ptc_trip = A.winding > PTC_TRIP_C;
  const running = !stopped && eng.ew.rate > 100;
  // Product warms if it is made warm (demo switch) or sits on a jammed belt.
  const target = BASE.product + (eng.warmProduct ? 10 : 0) + (rel('cur_belt') > 0.5 ? 6 : 0);
  A.product += (target - A.product) * 0.08 + gauss() * 0.04;
  A.entry = A.product + 1.5;
  const excess = running ? Math.max(0, A.entry - FREEZER_NOMINAL_ENTRY) : 0;
  A.chamber += ((BASE.chamber + 0.7 * excess) - A.chamber) * 0.03;
  A.compressor = (running ? BASE.compressor * (1 + 0.03 * excess) : 30) + gauss() * 0.15;
  A.packed = running ? eng.ew.rate * (1 - eng.ew.defect / 100) : 0;
  for (const k of HIST_KEYS) { A.hist[k].push(+A[k].toFixed(2)); if (A.hist[k].length > 160) A.hist[k].shift(); }

  // Attach the motor drive reading to an open diagnosis as supporting evidence, once.
  if (eng.active && !eng.active.support) { const s = support(eng, eng.active.type); if (s) { eng.active.support = s; eng.patchExplanation({ support: s }); eng.event('supporting_evidence', 'system', 'motor drive', s, { issueId: eng.active.id }); } }

  // Quality warning: product entering the blast freezer too warm.
  const limit = entryLimit(eng.db);
  A.warmTicks = running && A.entry > limit ? A.warmTicks + 1 : 0;
  if (A.warmTicks === 6) {
    const text = `Product is entering the blast freezer at ${A.entry.toFixed(1)} °C; the limit is ${limit} °C. Warm product freezes slower, loads the freezer (chamber ${A.chamber.toFixed(1)} °C, compressor ${A.compressor.toFixed(1)} A) and risks quality. Check dough and filling temperature and how long product waits on the belt.`;
    const id = unusual.raise(eng, 'warm_product', new Date(eng.now()).toISOString().slice(0, 13), text, { entry_c: +A.entry.toFixed(1), limit_c: limit });
    if (id) unusual.alertPeople(eng, id, 1, `${eng.machine.name}: product too warm at freezer entry. ${text}`, 'product temperature');
  }
  return A;
}

const entryLimit = (db) => { const n = Number(db.prepare("SELECT value FROM settings WHERE key = 'freezer_entry_max_c'").get().value); return Number.isFinite(n) ? n : 18; };

// Motor drive current as supporting evidence for a diagnosis. It never changes the diagnosis or its confidence.
function support(eng, type) {
  const A = eng.aux; if (!A || !A.vfd_amps || eng.stopped) return null;
  const pct = Math.round((A.vfd_amps / BASE.vfd_amps - 1) * 100);
  if (pct < 15 || !['jam', 'bearing', 'wrap'].includes(type)) return null;
  return `Main drive current from the motor drive (VFD) is ${pct} % above normal (${A.vfd_amps.toFixed(1)} A, normal ${BASE.vfd_amps}), and torque is ${Math.round(A.vfd_torque)} %. A motor working this hard supports the diagnosis. Winding temperature ${A.winding.toFixed(0)} °C.`;
}

function setEntryLimit(eng, value, user) {
  eng.need(user, 'manager');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 40) throw Object.assign(new Error('The limit must be between 0 and 40 °C'), { status: 400 });
  const old = eng.setting('freezer_entry_max_c');
  eng.db.prepare("UPDATE settings SET value = ? WHERE key = 'freezer_entry_max_c'").run(String(n));
  eng.event('config_changed', 'user', user.name, `${user.name} changed the freezer entry temperature limit from ${old} °C to ${n} °C`);
  eng.audit(user, 'set_freezer_entry_limit', { from: Number(old), to: n });
}

function setWarm(eng, on, user) {
  eng.need(user, 'operator');
  eng.warmProduct = !!on;
  eng.event('demo_fault', 'user', user.name, on ? 'Demo: warm product played into the simulated line' : 'Demo: product temperature set back to normal');
}

// What the dashboard shows: values, the four stages of the chain, and where the problem is.
function view(eng) {
  const A = eng.aux; if (!A) return null;
  const limit = entryLimit(eng.db), st = eng.state(eng.seq), m = st.machine, a = st.active;
  const r1 = (x) => +x.toFixed(1);
  const warm = A.packed > 100 && A.entry > limit, jam = !!a && a.type === 'jam';   // only product that is actually arriving can load the freezer
  const formingStatus = m.stopped ? 'stopped' : a ? (['critical', 'high'].includes(a.severity) ? 'fault' : 'warning') : 'ok';
  const stages = [
    { id: 'forming', name: 'Forming (AP800)', status: formingStatus, detail: m.stopped ? 'Machine stopped' : a ? a.title : eng.ew ? `${Math.round(eng.ew.rate)} kg/h` : 'Restarting', source: 'Line PLC — OPC UA' },
    { id: 'conveyor', name: 'Conveyor', status: jam ? 'fault' : warm ? 'warning' : 'ok', detail: jam ? 'Belt jammed' : `Product ${r1(A.product)} °C`, source: 'IR camera — Ethernet' },
    { id: 'freezer', name: 'Blast freezer', status: warm || A.chamber > -29 ? 'warning' : 'ok', detail: `Chamber ${r1(A.chamber)} °C, entry ${r1(A.entry)} °C`, source: 'Freezer controller — Modbus' },
    { id: 'packaging', name: 'Packaging', status: A.packed > 100 ? 'ok' : 'waiting', detail: A.packed > 100 ? `${Math.round(A.packed)} kg/h` : 'No product arriving', source: 'Line PLC — OPC UA' },
  ];
  const bad = stages.find((s) => s.status === 'fault' || s.status === 'stopped') || stages.find((s) => s.status === 'warning');
  return {
    simulated: true, warm_demo: !!eng.warmProduct, entry_limit: limit,
    values: { vfd_amps: r1(A.vfd_amps), vfd_torque: Math.round(A.vfd_torque), vfd_speed: Math.round(A.vfd_speed), winding: r1(A.winding), ptc_trip: !!A.ptc_trip, product: r1(A.product), entry: r1(A.entry), chamber: r1(A.chamber), compressor: r1(A.compressor), packed: Math.round(A.packed) },
    normal: BASE, ptc_trip_c: PTC_TRIP_C, hist: A.hist, stages, problem_at: bad ? bad.name : null,
    freezer_risk: warm ? `Product is entering ${r1(A.entry - limit)} °C above the limit. Freezer load is up: compressor ${r1(A.compressor)} A against ${BASE.compressor} A normal.` : null,
    support: a ? support(eng, a.type) : null,
  };
}

module.exports = { step, view, support, setEntryLimit, setWarm, entryLimit, SOURCES, BASE };
