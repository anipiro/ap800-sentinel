# Demo checklist: AP800 Sentinel

Public address: https://picnic-susan-example-dealers.trycloudflare.com
Local address (always works on this laptop): http://localhost:4800

All commands are for PowerShell. Open two PowerShell windows before the demo: one for the server, one for the tunnel.

## Before you present

1. Plug the laptop in and stop it sleeping: `powercfg /change standby-timeout-ac 0`
2. Check both are up:
   ```powershell
   (Invoke-WebRequest http://localhost:4800/api/health -UseBasicParsing).Content     # expect {"ok":true}
   Get-Process cloudflared                                                            # expect one process
   ```
3. Open the public address, sign in as Mariam, wait for "Running normally".

The server and the tunnel were started from the Claude Code session. If that session is closed they stop. To be independent of it, restart both in your own windows using the commands below. Restarting the tunnel gives a new address.

## Rules while presenting

- **One issue at a time.** While an issue is open, pressing another fault button does not open a second issue; the open one stays on screen. Resolve it (or press "Back to normal" and wait about 10 seconds) before the next fault.
- Everyone on the link shares one machine. If a jury member presses a fault button, you will see their fault. Sign in as Mariam and press "Mark resolved" to clear it.
- After "Mark resolved", wait about 5 seconds before the next fault: the machine restarts and detection is paused briefly.
- If the machine shows "Machine stopped" with no issue, open the last issue and undo the shutdown, or reset the database (below).

## Demo script (about 4 to 5 minutes spoken; 50 seconds when clicked through without talking)

1. Sign in as **Mariam (production manager)**. Live tab, "Running normally".
2. Press **Gearbox bearing wears**. In 4 to 5 seconds the issue appears: reason, readings, time to failure, loss so far, parts warning.
3. Wait 20 seconds: "Alerted: Level 2 of 3" shows the escalation.
4. Press **Approve** on "Shut the machine down safely". Status becomes "Machine stopped".
5. Fill in root cause, fix, parts, minutes. Press **Mark resolved**. Status returns to "Running normally".
6. Issues tab: open the issue. Show lifecycle, explanation, replay. Press **Verify the repair**.
7. Work orders tab: assign a work order; show the calendar window and spare parts.
8. Summary tab: KPIs and shift handover. Losses tab: loss and savings.
   - Live tab: point at the **Line chain** strip and the source label under each chart. Press **Thermal view** on the camera, then **Warm product reaches the freezer**: within 15 seconds the conveyor and freezer turn amber and the technician is alerted. Press both again to switch them off.
   - Ask tab: press "What should we fix first?" and "Why did the last issue happen?".
9. Risk tab: projection and heatmap. Press **Temperature sensor reads 180 °C** to show unusual activity (flag appears in 2 seconds), then **Switch tests off**.
10. Simulator tab: run **Pressure sensor drops out**; show the before/after table.
11. Optional: sign in as **Nino (operator)** in another browser to show that Losses, Setup, Approve and Resolve are not available.
12. Optional: open the public address on a phone, **My work** tab, show the QR code.

## Restart the server (address stays the same)

```powershell
Get-NetTCPConnection -LocalPort 4800 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
cd C:\Users\User\projects\ap800-sentinel
npm start
```

Leave that window open. It prints `AP800 Sentinel running at http://localhost:4800`. The public address works again within a few seconds.

## Reset to a clean database

```powershell
Get-NetTCPConnection -LocalPort 4800 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Remove-Item C:\Users\User\projects\ap800-sentinel\data -Recurse -Force
cd C:\Users\User\projects\ap800-sentinel
npm start
```

This deletes all issues, history, work orders, knowledge-base entries and stored simulations, and restores default settings, costs, stock and assumptions. The production value goes back to the default 3,000 GEL per hour: set it to 3,600 again on the Losses tab (Cost settings) after a reset.

## Restart the tunnel (gives a NEW public address)

```powershell
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:4800
```

Leave that window open. After a few seconds it prints a box containing a line like:

```
https://some-random-words.trycloudflare.com
```

That is the new public address. The old one stops working. Share the new one and open it once yourself to confirm it loads.

## If something goes wrong

| What you see | What to do |
|---|---|
| Public address does not load, localhost does | Restart the tunnel, share the new address. Or present from http://localhost:4800 |
| Neither loads | Restart the server |
| Page loads but nothing moves | Reload the page. If still stuck, restart the server |
| Stale or confusing issue on screen | Sign in as Mariam, "Mark resolved". If that fails, reset the database (about 10 seconds) |
| No internet at all | Present from http://localhost:4800. The QR code is replaced by the plain address; everything else works |
| Nothing works | Use the backup screenshots |

## Backup screenshots

`C:\Users\User\projects\ap800-sentinel\demo-backup` holds numbered screenshots of the full flow in the final design, from sign-in to the phone view.

## Sign-in

No password. Pick a person: Nino (operator), Giorgi or Luka or Tamar (technicians), Mariam (manager).
