# PLC safety requirements for PLTM HMI

**For:** the PLC programmer and the panel builder of the Pantograph Load Testing Machine.

The PC software is not a safety device. Windows can freeze, the USB cable can be pulled, and the operator can close the app mid-test. Every function that protects people or the machine must therefore work in the **PLC program and the hard wiring**, with the machine stopping safely even if the PC is off. The software only *shows* these functions and gives the PLC its set-points.

This follows the approach of IEC 60204-1 (electrical equipment of machines) and ISO 13849-1 (safety-related control systems). The required performance level should be set by the machine's risk assessment.

## What the PLC must do

| # | Function | Requirement |
|---|---|---|
| 1 | **Emergency stop** | Hard-wired E-stop (panel and remote pendant) removes servo enable / drive power through the safety circuit, independent of the PLC program and the PC. Stop category 0 or 1. The E-stop **latches**: releasing it must not restart motion. Motion resumes only after the E-stop is released **and** RESET is pressed **and** START is pressed. |
| 2 | **Overload trip** | The PLC compares the load-cell reading with the overload limit on every scan. Above the limit it stops motion immediately and **latches** an overload flag until RESET. The limit is written by the app (see below); the PLC must also have a fixed hard maximum it never exceeds, whatever the app writes. |
| 3 | **Over-travel limits** | Upper and lower limit switches, wired to stop motion in the direction of travel. A soft limit at the height capacity written by the app. After a limit trip, only jogging *away* from the limit is allowed. |
| 4 | **Communication watchdog** | The app increments a heartbeat register every 500 ms. If the value has not changed for **2 seconds** while the pantograph is moving, the PLC stops motion (as STOP / HALT). This stops the machine if the PC crashes, freezes or loses the cable. |
| 5 | **No automatic restart** | After power returns, after a fault is cleared, or after the communication link comes back, the machine stays still until an operator presses START. |
| 6 | **Safe default commands** | Pulse commands (START, STOP, RESET, HOMING) act on the rising edge only. Jog commands are level signals: jog only while the value is 1, and stop when it returns to 0 **or** when the heartbeat stops. |

## What the PLC must publish (Modbus)

These map to the `safety` and `writes` sections of the register map in **SETTINGS → CONNECTION**. Addresses below are the placeholder layout shipped with the software; use whatever the PLC program defines.

| Register map entry | Direction | Meaning | Placeholder |
|---|---|---|---|
| `safety.estop` | PLC → app | E-stop chain open (any E-stop pressed). Set `activeValue` to the value meaning *pressed*. | discrete input 1 |
| `safety.overloadTrip` | PLC → app | Overload flag latched. | discrete input 2 |
| `safety.upperLimit` | PLC → app | Upper over-travel limit reached. | discrete input 3 |
| `safety.lowerLimit` | PLC → app | Lower over-travel limit reached. | discrete input 4 |
| `safety.heartbeat` | app → PLC | Counter 0–65535, incremented every 500 ms while connected. | holding register 6 |
| `writes.overloadLimit` | app → PLC | Overload limit in N (the machine's load capacity). Written on every connection and when changed in Settings. | holding register 4, scale 0.1 |
| `writes.travelLimit` | app → PLC | Soft upper travel limit in mm (the machine's height capacity). Same timing. | holding register 5, scale 1 |

When a safety signal is active the app shows it regardless of the status register: **EMERGENCY PRESSED**, **OVERLOAD**, or **OVER TRAVEL**, and refuses START and HOMING until it clears and RESET is pressed.

The app also keeps a backup software overload trip (it sends STOP if the reading exceeds the load capacity). This is a second layer only; it does not replace function 2.

## Commissioning checks

Run these with the machine, the PLC programmer and the app connected. Every one must pass before hand-over.

- [ ] Press each E-stop during a raising test: motion stops at once, the app shows EMERGENCY PRESSED. Release it: nothing moves. RESET, then START: the test can run again.
- [ ] Hang a load above the overload limit (or lower the limit temporarily): motion stops, the app shows OVERLOAD, START is refused until RESET.
- [ ] Jog up into the upper limit switch: motion stops, the app shows OVER TRAVEL; jogging down is possible.
- [ ] During a raising test, unplug the PC's USB adapter or network cable: the machine stops within 2 seconds.
- [ ] During a raising test, close the app from Task Manager: the machine stops within 2 seconds.
- [ ] Switch the Control Box off and on during a test: after power returns nothing moves until START.
- [ ] Change the load capacity in **SETTINGS → MACHINE**: the PLC's overload limit register shows the new value.
