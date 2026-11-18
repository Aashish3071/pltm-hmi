# PLC interface and commissioning

PantoCheck drives the pantograph tester through its PLC. The PLC runs the test cycle and its interlocks (homing, E-stop, overload, the raise–dwell–lower sequence); PantoCheck sets command bits, sends set-points and reads a status string.

## Siemens S7 (default)

S7 communication over Ethernet (ISO-on-TCP, port 102). Default: PLC `192.168.0.1`, rack 0, slot 1, data block **DB6**. Every address below can be changed under **SETTINGS → SYSTEM**.

| DB6 address | Type | Meaning |
| --- | --- | --- |
| DBX0.3 | Bool | START (set by the app, cleared by the PLC) |
| DBX0.6 | Bool | RESET |
| DBX1.0 | Bool | HOMING (2 s pulse) |
| DBX1.2 | Bool | STOP / pause: set by STOP, cleared by START or RESUME |
| DBD2 | Real | Travel distance (mm), written at every START |
| DBD6 / DBD10 / DBD14 | Real | Up / down / jog speed (mm/s) |
| DBB1866 | String[50] | Status string (below) |

On S7-1200/1500 PLCs: allow **PUT/GET communication** and switch off **optimized block access** for the data block.

### Status string

Six numbers separated by spaces, polled every 25 ms:

```
load × 100   position (mm)   status code   up time (s)   down time (s)   mode (1 = MANUAL, 2 = AUTO)
```

| Code | Status | Code | Status |
| --- | --- | --- | --- |
| 0 | READY | 51 | HALT |
| 1 | EMERGENCY PRESSED | 61 | PANTO RAISING |
| 11 | SERVO ERROR | 71 | PANTO RAISING COMPLETED |
| 21 | OVERLOAD | 81 | PANTO RETRIEVING |
| 31 | SERVO OFF | 91 | CYCLE COMPLETED |
| 41 | HOMING NOT DONE | — | ETHERNET DISCONNECTED (no link) |

## Modbus

For PLCs that publish the same values in registers: Modbus RTU on a COM port (USB-to-RS485), RTU over a TCP gateway, or Modbus TCP. The register map (load, position, status code, times, mode, command coils, speed registers) is edited as JSON under **SETTINGS → SYSTEM**.

## How a test is recorded and evaluated

- **START** writes the travel distance, clears STOP, sets START and starts recording. Every poll is added to the current test, **n**, until the PLC reports CYCLE COMPLETED.
- **RESET** moves n to n-1 and n-1 to n-2. The graph can overlay all three.
- The plotted load is smoothed with a 70-sample zero-phase moving average.
- Results come from the raising (codes 61, 71) and lowering (81) readings between the model's 2nd and 3rd heights:

| Result | Formula |
| --- | --- |
| Avg up force | mean raising load |
| Avg down force | mean lowering load |
| Mean force | (up + down) / 2 |
| Peak friction | max(lowering) − min(raising) |
| Hysteresis | down − up |
| Height reached | highest raising position |

## Commissioning checklist

1. Connect the PC to the PLC's Ethernet port and give it an address on the PLC's network, for example `192.168.0.10 / 255.255.255.0`.
2. Log in as **ADMIN / 1234**, open **SETTINGS** (administrator sign-in), then **SYSTEM**. Check the driver, IP, rack and slot.
3. **TEST CONNECTION** (read-only): it should show the PLC's status, load and position. *Access denied* means PUT/GET is not allowed or the data block is optimized.
4. **SAVE**, then **HOME**: the status changes from ETHERNET DISCONNECTED to the PLC's status.
5. In Settings press **UPLOAD** and confirm DB6.DBD6/10/14 hold the speeds.
6. On Home: **HOMING**, then **START** with a model selected; confirm the travel matches the model's point 4 (DB6.DBD2).
7. Enter the company name and address under SYSTEM (printed on reports) and change all four passwords.
