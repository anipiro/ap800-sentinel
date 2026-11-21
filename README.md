# AP800 Sentinel

Fault-detection MVP for the Signal-Pack AP800 dumpling machine.

## Run

```
node server.js
```

Open http://localhost:4800. No install step, no dependencies (Node 18+).

## What is real and what is simulated

- Machine signals (motor currents, vibration, temperature, filling pressure, thickness) are simulated.
- Baseline learning and fault detection are real code running on those signals: the first 20 seconds are recorded as "normal", then rules fire when signals leave the learned band.
- The exit belt camera runs real image analysis on a 25-second clip of the actual machine: it finds products on the blue belt and measures belt movement. "Flagged" products during a test fault are simulated.
- The phone sensor is a real sensor path: `public/device.html` reads the phone accelerometer and posts to `/api/ingest`; the dashboard learns its normal level and raises an incident when it rises.

## Demo script

1. Open the dashboard and wait for "Running normally".
2. Under "Test a fault", press a fault. Within a few seconds the station turns red and an incident appears with the cause and what to check.
3. Press "Back to normal". The incident clears by itself.
4. Good ones to show: "Filling runs out" (pressure drops, defects climb), "Gearbox bearing wears" (warning first, then critical), "Exit belt jams" (the camera sees the belt stop).

URL shortcuts: `?fast=1` shortens learning to 5 seconds, `?fault=starve` starts a fault automatically (tear, hopper, wrap, starve, block, cell, bearing, jam).

## Phone as a sensor

Phones only share motion data over HTTPS. Expose the server through an HTTPS tunnel, open the tunnel address on the laptop and `/device.html` on the phone, then press "Start sending".

To test the path without a phone:

```
curl -X POST localhost:4800/api/ingest -d "{\"vib_rms\":0.3}"
```

Send about 15 readings near 0.3, then one near 2.5.

## Files

- `server.js` website, `/api/ingest`, `/api/stream`
- `public/index.html`, `public/app.js` dashboard, simulator, detection, camera analysis
- `public/device.html` phone sensor page
- `docs/architecture.html` the full plan
