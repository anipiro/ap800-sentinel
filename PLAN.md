# PLAN — Machine Monitoring Intelligence Module

Status: **waiting for approval.** Nothing in this plan has been implemented.

## 1. What exists today

| Area | Current state |
|---|---|
| Stack | Node 25, zero dependencies. `server.js` (61 lines) serves static files and relays readings. Front end is one HTML page and one vanilla JS file, no framework, no build step. |
| Machine data | No real machine is connected. Fifteen signals (7 motor currents, 2 vibration, gearbox temperature, filling pressure, sheet thickness, output, defect rate, belt movement) are **simulated in the browser** at 2 Hz. One real source exists: a phone accelerometer posting to `POST /api/ingest`. |
| Detection | In the browser: 20-second baseline, rolling z-score, 9 hand-written rules. No ML model. |
| Storage | None. Everything is lost on page reload. |
| Users, roles, login | None. |
| Notifications | None (only a beep in the browser). |
| Machine control | None. No interface to the AP800 controller. |
| Tests, migrations, git | None. The folder is not a git repository. |
| Machines | One: AP800 dumpling line, with 7 stations. |

The master prompt assumes an application with a database, users and notifications. This one has none of them, so most of Phase 1 is new foundation, not an add-on.

## 2. Assumptions (the Context block in the prompt was left as placeholders)

These are my defaults. Correct any of them before approval.

| Item | Assumed |
|---|---|
| Application | Fault-detection dashboard for one Signal-Pack AP800 line, hackathon MVP |
| Data source | Server-side simulator, plus the phone sensor. No real PLC data |
| Roles | operator, technician, manager, admin |
| Channels | In-app and Telegram. Telegram runs as a mock unless a bot token is set |
| Currency | GEL |
| Languages | English first, Georgian as a second translation file |
| Escalation timeout | 5 minutes real, shortened to 20 seconds in demo mode |
| Retention | Full resolution 30 days, hourly averages 2 years |
| "Fleet" | AP800 stations are treated as components of one machine. Two extra simulated machines are added so fleet views, ranking and cascading failure have something to show |

## 3. Decisions

1. **Stay on Node with no npm dependencies.** Database is `node:sqlite` (built in, verified working on this machine; still flagged experimental by Node). Tests use `node:test`. Front end stays vanilla JS with the existing styles.
2. **Move the simulator and detection to the server.** The browser becomes a viewer. This is the one large refactor; without it there is no history, no notifications and no audit trail.
3. **ML in JavaScript, written by hand.** Isolation Forest (about 150 lines) for anomaly detection, a nearest-centroid classifier for issue type, linear trend extrapolation for remaining useful life. Explanations come from per-feature deviation from baseline, ranked and written as sentences. This is feature contribution, not SHAP; real SHAP would need Python.
4. **All training data is synthetic.** Precision, recall and false-positive rate will be reported, but they measure the model against the simulator, not against a real AP800. The UI and README will say so.
5. **Machine control is a mock adapter.** `Actuator` interface with `MockActuator`. Physical actions (stop, speed change) need manager approval by default.
6. **Simulation isolation by construction.** Sandbox runs get their own `MockNotifier` and `MockActuator` instances and write rows with `is_simulated = 1`. The real notifier and actuator are never passed into the sandbox, and a test proves it.
7. **Append-only history is enforced in the database** with triggers that reject `UPDATE` and `DELETE` on `events` and `audit_log`.
8. **Login is simple.** Seeded users, password hash with `node:crypto` scrypt, signed session cookie. No sign-up flow, no OAuth.
9. **AI assistant (item 13) needs a Claude API key.** Without `ANTHROPIC_API_KEY` the chat panel is hidden. Read-only tools over the app's own tables.
10. **PDF export** is a print-styled HTML page the user saves as PDF from the browser. CSV is generated server-side.

## 4. Architecture

```
simulator ─┐
phone      ─┼─> ingest ─> readings (SQLite) ─> feature window ─> IssueDetector
(future PLC)┘                                                      │
                                                                   v
                            issues ──> loss engine ──> remediation engine ──> Actuator (mock)
                               │                              │
                               v                              v
                        notifier + escalation           approvals (manager)
                               │
                 every step writes ──> events (append-only) + audit_log
                               │
                REST API + SSE ──> dashboard, issue view, history, summary, risk pages
```

Sandbox runs use the same detector, loss engine and remediation code with mock notifier and actuator, on a separate in-memory reading stream.

## 5. Data model (SQLite, one migration file per phase)

| Table | Purpose | Key columns |
|---|---|---|
| `machines` | Fleet | id, name, model, installed_at, depends_on |
| `components` | Stations | id, machine_id, name, kind |
| `readings` | Raw 1 s data | machine_id, ts, signal, value. Index (machine_id, signal, ts) |
| `readings_hourly` | Downsampled | machine_id, hour, signal, avg, min, max |
| `model_versions` | Trained models | id, trained_at, params_json, precision, recall, fpr, active |
| `issues` | Detected problems | id, machine_id, component_id, type, severity, confidence, explanation_json, model_version_id, status, is_simulated, detected_at … verified_at |
| `issue_readings` | Snapshot before and after | issue_id, ts, signal, value |
| `users` | People | id, name, role, password_hash, telegram_id, locale |
| `shifts` | On-duty schedule | user_id, weekday, start, end |
| `responsibilities` | Escalation chain | machine_id, user_id, level |
| `notifications` | Delivery tracking | id, issue_id, user_id, channel, level, sent_at, delivered_at, acked_at |
| `actions` | Remediation | id, issue_id, kind, risk, status (auto, pending_approval, approved, rejected, done, reverted), reason, confidence, decided_by |
| `settings` | Switches | key, value (includes `automation_enabled`) |
| `cost_params` | Per machine | production_value_h, downtime_cost_h, labour_h, scrap_unit, energy_kwh |
| `downtime` | Stoppages | machine_id, issue_id, start, end |
| `events` | Timeline, append-only | id, machine_id, ts, type, actor_type, actor_id, ref_table, ref_id, data_json, is_simulated. Index (machine_id, ts, type) |
| `audit_log` | Security trail, append-only | ts, user_id, action, detail_json |
| `simulations` | Stored runs | id, scenario, params_json, result_json, created_by |
| `unusual_flags` | Phase 2c | id, machine_id, kind, severity, explanation, data_json, verdict |
| `work_orders`, `parts`, `part_links`, `kb_entries` | Phase 3 | lifecycle status, stock, lead time, root cause, fix |
| `webhooks`, `reports` | Phase 4 | url, events, schedule |

## 6. Files

```
server.js                    thin entry: routes + static
src/db.js                    connection, migration runner
migrations/001_core.sql …    one per phase
src/sim/machine.js           signal simulator (moved from public/app.js)
src/sim/scenarios.js         fault scenarios
src/ml/features.js           window features
src/ml/isolationForest.js    model
src/ml/detector.js           IssueDetector.predict(machineId, readings)
src/ml/explain.js            feature contributions → sentences
scripts/generate-data.js     synthetic history
scripts/train.js             train, evaluate, save model version
src/notify/                  notifier interface, inApp, telegram, mock, escalation
src/remediation/             rules, guardrails, actuator interface, mock
src/finance/loss.js          all formulas, documented, unit-tested
src/history/events.js        append-only writer, queries, export
src/auth/                    sessions, roles, permission check
src/api/                     REST handlers
src/sandbox/                 isolated scenario runner, Monte Carlo
public/                      dashboard, issue, history, summary, risk pages; i18n/en.json, ka.json
test/                        node:test suites
.env.example
```

## 7. Build order

**Phase 0 — foundation (required before anything else)**
`git init`, SQLite and migrations, move simulator and detection server-side, persist readings, keep the current dashboard working from the API. Add two extra simulated machines.

**Phase 1 — core**
1. Synthetic data generator, features, Isolation Forest, type classifier, severity, RUL, explanations, metrics, `scripts/train.js`.
2. Fleet dashboard with health cards, charts with anomaly markers, issue detail view.
3. Users, roles, login, shifts, responsibility chain, notifier, escalation, delivery tracking.
4. Remediation rules, approval flow, automation-off switch, mock actuator.
5. Cost parameters, loss engine, loss dashboard, ROI summary.
6. Summary page, plain-language insights, CSV and print-to-PDF export.
7. Events timeline, machine profile, issue lifecycle, filters, period and machine comparison, retention job.

Tests: detection pipeline, loss formulas, escalation, guardrails, role permissions, append-only triggers.

**Phase 2 — simulation and risk**
Scenario simulator with what-if parameters, Monte Carlo 7/30/90-day projection, risk heatmap, unusual-activity flags with feedback, risk overview page, minute-by-minute replay, simulated/real labelling. Test: sandbox never reaches the real notifier or actuator.

**Phase 3 — maintenance operations**
Calendar and window suggestion, work orders, spare parts with lead time in the loss calculation, technician mobile view with QR per machine, photo and note upload, root cause and knowledge base, similar past issues.

**Phase 4 — intelligence and platform**
AI assistant, OEE/MTBF/MTTR, energy and CO₂, drift monitoring and model rollback, scheduled reports and shift handover, full audit views, REST API and webhooks, Georgian translation.

Each phase ends with tests passing, a commit per feature, and a stop for review.

## 8. Risks

- **Size.** This is 18 features across four phases, on a codebase of 744 lines. Phase 0 and Phase 1 are the bulk of the work. Phases 3 and 4 will not fit a hackathon.
- **Demo regression.** Phase 0 rewrites the part of the MVP that currently works. Until it is finished the demo is broken. I will do it on a branch and keep the current version runnable.
- **`node:sqlite` is experimental.** It works on Node 25 here. If the demo machine has an older Node it will not start. Fallback is the `better-sqlite3` package, which breaks the zero-dependency rule.
- **Credibility of ML numbers.** Metrics come from synthetic data. Judges who ask "what is your recall on real faults" get the answer "unknown".
- **The published artifact stops being a full copy.** The online link is a static page; once logic moves to the server, it can only show a recorded demo. A real public URL then needs hosting for the Node server.

## 9. Recommended hackathon cut

If time is the constraint, I recommend approving this subset and leaving the rest as roadmap slides:

- Phase 0
- Phase 1 items 1, 2, 4, 5 and a reduced 3 (in-app plus Telegram, one escalation step, no shift schedule)
- Phase 1 item 7 reduced to the per-machine timeline
- Phase 2a scenario simulator with loss comparison (early, late, not caught)

This gives the story judges respond to: ML finds it, explains it, tells the right person, proposes a safe action, and shows the money saved.

## 10. Questions

1. Full plan, or the hackathon cut in section 9?
2. When is the demo? This decides how much of Phase 1 is realistic.
3. Is the Context table in section 2 right (GEL, English then Georgian, Telegram, four roles)?
4. Do you have a Telegram bot token, or should notifications stay mocked on screen?
5. One AP800 with two invented neighbour machines, or keep it strictly to the one real machine?
6. Do you have real cost figures (value of an hour of production, technician hourly rate), or should I use placeholders marked as examples?
7. Will the demo run from this laptop, or does it need a public URL?
