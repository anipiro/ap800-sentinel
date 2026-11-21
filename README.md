# AP800 Sentinel

Fault detection and monitoring for the Signal-Pack AP800 dumpling machine. Hackathon build.

## Run

```
npm start
```

Open http://localhost:4800 and choose a person to sign in as. Needs Node 22.13 or newer. No packages to install.

| Command | What it does |
|---|---|
| `npm start` | Runs the website, the simulated machine and the detection engine |
| `npm test` | Runs the test suite (51 tests) |
| `npm run train` | Retrains the detection model on fresh synthetic data. Restart the server afterwards |
| `npm run reset` | Deletes the database so the next start is clean |

## Environment variables

Copy `.env.example`. All are optional.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 4800 | Port of the website |
| `ESCALATE_AFTER_S` | 20 | Seconds before an unacknowledged issue goes to the next person |
| `TELEGRAM_BOT_TOKEN` | empty | Without it, Telegram messages are recorded but not sent |
| `DB_PATH` | `data/sentinel.db` | SQLite database file |

## What is real and what is not

- **Simulated:** all machine signals. There is no connection to a real AP800.
- **Real code on simulated data:** the Isolation Forest model, fault classification, explanations, issue lifecycle, escalation, approval guardrails, loss calculation, history.
- **Real data:** the exit-belt camera analysis runs on a 25-second clip of the actual machine. The phone sensor page reads a real accelerometer.
- **Placeholders:** people, shifts, cost figures, the assumed kit cost used for ROI.
- **Mock:** machine control. Commands are recorded and stop the simulated machine. Telegram is not sent.
- **Demo clock:** one real second counts as one minute of production for durations and money.
- **Sign-in:** pick a person, no password. Not suitable for real use.

Model metrics are measured on synthetic test data from the same simulator. They say nothing about accuracy on a real machine.

## Roles

| Role | Can do |
|---|---|
| Operator | See everything except money and setup, acknowledge issues, use the fault test buttons |
| Technician | Also resolve issues and run low-risk actions |
| Manager | Also approve or undo machine actions, verify repairs, see losses, change settings and costs |

## Demo script

1. Sign in as Mariam (manager). Wait for "Running normally".
2. On Live, press "Gearbox bearing wears". In about 3 seconds an issue opens with the reason, the readings behind it, time to failure, and the loss so far.
3. Low-risk actions are already done. "Shut the machine down safely" waits for approval. Leave it for 20 seconds to show escalation to the next person.
4. Approve the shutdown. The machine stops and downtime starts costing money.
5. Type what was fixed and press "Mark resolved". The machine restarts.
6. Open the issue's full record, then Losses, History and Summary.
7. In a second browser, sign in as Nino (operator) to show that Losses and Setup are hidden and approval is refused.

## Simulations and risk (Phase 2)

- **Simulator tab** (technician and manager): pick a scenario, severity, speed, time of day and response delay. The run happens in a sandbox with its own in-memory database, mock notifiers and a mock actuator. It shows time to detection, who would be alerted, what would run, and the loss if caught early, caught late, or not acted on. Runs are stored in the `simulations` table only and can be replayed and exported.
- **Untrained scenarios**: pressure sensor freezing, dropping out or drifting, a power surge, and a gradual performance drop are in the simulator but not in the model's training data. Each result states plainly whether the model handled it correctly, saw it without understanding it, named the wrong fault, or missed it. Before the cross-check below was added: frozen sensor is missed by the fault model and caught by the activity monitor; drop-out and drift are named as filling faults, which is wrong; a surge is seen as an unclassified anomaly; a performance drop is detected after about an hour and named wrongly.
- **Cross-check** (added after the first results; the model was not retrained): the activity monitor is connected to the fault model.
  - If a sensor is flagged as frozen, out of range, changing impossibly fast, or just back from a data gap, any diagnosis that depends on it is shown as "Possible sensor fault: check the … sensor", with the model's diagnosis listed as "if the sensor is correct". Only a work order to check the sensor is created; no stop is recommended; the technician is alerted as a sensor issue. An issue already open is reclassified and its pending machine action withdrawn.
  - A diagnosis that rests on one sensor while the rest look normal has its confidence lowered and says so. A machine action on a low-confidence diagnosis always needs manager approval and carries a warning. The warning is lifted when other sensors come to agree.
  - Every sensor flag is sent to the technician on duty.
  - The Simulator tab has a before/after table for the five untrained scenarios. After the cross-check: drop-out is correctly shown as a possible sensor fault; a frozen sensor is still missed by the fault model but the technician is now alerted; drift and performance drop are still named wrongly, at lowered confidence and with the machine action held back; a surge is unchanged.
- **Cross-check, round 2** (still no retraining):
  - *Corroboration.* A flagged sensor only turns a diagnosis into a possible sensor fault if no trusted sensor moves the way the fault predicts. If others agree, the fault and its actions stay and the flag is shown as a sensor note. A real blockage at maximum speed and severity stays a blockage.
  - *Unknown-anomaly threshold.* Below a confidence threshold (Setup page, default 40 %, manager-only, audit-logged) no fault is named: the issue is "Unclassified anomaly: inspect the machine" with the top candidate listed as most likely, an inspection work order, a technician alert, and no machine action. It is named later if confidence reaches the threshold.
  - *Warning heeded or ignored.* Where a low-confidence warning decides the outcome, the simulator runs both and shows both losses.
  - *Data gaps* are detected between any two readings, not only after a restart.
  - The Simulator tab compares all thirteen scenarios across three columns: before the cross-check, after round 1, after round 2.
- **Risk tab**: Monte Carlo projection for 7, 30 and 90 days (2,000 random futures), risk ranking, heatmap and loss distribution. Event rates are placeholders that blend with recorded issue history.
- **Unusual activity**: frozen sensor, physically impossible readings (outside the sensor range, or changing faster than the quantity can), energy use while stopped, running outside 06:00 to 22:00, a safeguard switched off, three or more rejected or undone actions in a day, a gap in the data. Each flag can be marked expected, investigated or escalated. Every check has a test button on the Risk tab except the data gap, which appears after a server restart, and the safeguard change, which you trigger on the Setup page. Out-of-range readings are hidden from the fault model. Escalated flags land in the manager's inbox on the Live tab.
- **Assumptions**: event rates, minutes to breakdown, the early-catch rate and bearing age are editable by the manager on the Setup page and labelled "assumed" on the Risk tab.
- Everything simulated or projected is drawn with a dashed violet border and a SIMULATED or PROJECTION tag.

## Layout

```
server.js            routes and static files
src/sim.js           simulated signals and faults
src/ml/              Isolation Forest, detector, training
src/core.js          engine: issues, notifications, escalation, remediation, losses, events
src/adapters.js      notifier and actuator interfaces, real and mock
src/loss.js          financial formulas
src/reports.js       history, finance, summary queries
src/sandbox.js       isolated failure scenario simulator
src/risk.js          Monte Carlo risk projection
src/unusual.js       unusual activity detection
src/catalog.js       issue types, actions, cost assumptions
migrations/          database schema
test/                node:test suites
public/              dashboard and phone sensor page
legacy/              the earlier browser-only MVP
docs/, PLAN.md       architecture and plan
```
