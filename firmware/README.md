# PLTM controller firmware (Arduino)

Controller firmware for the Pantograph Load Testing Machine. It runs on an Arduino and is the Modbus RTU slave that the **PLTM HMI** app talks to. It drives the pantograph's motor, reads the load cell and the switches, and runs the safety functions of [`docs/plc-safety-requirements.md`](../docs/plc-safety-requirements.md) itself, so the machine stops safely even if the PC crashes.

It uses the app's **default register map**, so no changes are needed under SETTINGS → CONNECTION → REGISTER MAP. The map is listed in [`pltm-controller/Registers.h`](pltm-controller/Registers.h).

> **The E-stop must cut drive power in hardware.** Wire the E-stop's own contacts to remove power from the motor drive (or its enable/STO input), independent of the Arduino and the PC. The Arduino only *reads* a second contact so the app can show EMERGENCY PRESSED. An Arduino is not a certified safety controller. For a machine you sell, the hard-wired E-stop circuit is what makes it safe; the firmware is a second layer.

## What you need

| Part | Notes |
| --- | --- |
| Arduino **Mega 2560** (recommended) or Uno | Both work. The Mega has a second serial port for RS-485 and spare pins. |
| Step/dir motor drive | A stepper driver (e.g. DM542, TB6600) or a servo drive in pulse/direction mode. |
| **HX711** load-cell amplifier | Tie its **RATE** pin to VCC for 80 samples/s. At the default 10 samples/s the overload trip reacts 8× slower. |
| Home switch | At the bottom of the working range. |
| Upper and lower over-travel switches | **Normally closed (NC)**, outside the working range. |
| E-stop with **two** contact sets | One NC set cuts drive power; the other NC set goes to the Arduino. |
| Remote pendant (optional) | UP and DOWN push buttons. |
| RS-485 module (MAX485 or similar) | For the machine, instead of the USB cable (see below). |

## Wiring (default pins, Mega 2560)

All switch and button inputs use the Arduino's internal pull-ups: wire each between its pin and **GND**. NC safety switches then read *tripped* when the wire breaks, which is the safe failure.

| Signal | Pin | Wiring |
| --- | --- | --- |
| STEP | 3 | drive PUL+ (PUL− to GND) |
| DIR | 4 | drive DIR+ (DIR− to GND) |
| ENABLE | 5 | drive ENA+ (ENA− to GND); active LOW by default |
| HX711 DOUT | 6 | |
| HX711 SCK | 7 | |
| E-stop monitor | 8 | NC contact to GND |
| Home switch | 9 | NO contact to GND (set `HOME_SWITCH_NC 1` for NC) |
| Upper over-travel | 10 | NC contact to GND |
| Lower over-travel | 11 | NC contact to GND |
| Pendant UP | 12 | push button to GND |
| Pendant DOWN | 13 | push button to GND |
| RS-485 DE + /RE | 2 | only with `MODBUS_USE_RS485 1` |
| RS-485 DI / RO | 18 (TX1) / 19 (RX1) | only with `MODBUS_USE_RS485 1` (Mega only) |

Every pin, polarity and mechanical constant is in [`pltm-controller/config.h`](pltm-controller/config.h). Set a pin to `-1` if that part is not fitted. A drive alarm output can be wired to `DRIVE_ALARM_PIN`.

## Settings to check in `config.h`

| Setting | What to set |
| --- | --- |
| `STEPS_PER_MM` | Drive pulses per mm of pantograph travel (pulses/rev ÷ mm/rev of the mechanism). |
| `DIR_UP_HIGH` | Flip if the pantograph goes the wrong way. |
| `ACCEL_MM_S2`, `QUICK_STOP_MM_S2` | Normal ramp, and the harder ramp for STOP and safety stops. |
| `LOAD_COUNTS_PER_N`, `LOAD_ZERO_COUNTS` | Rough load-cell scale, used by the controller's own overload trip. The app's calibration corrects what the operator sees, but set this within a few percent. |
| `HARD_MAX_LOAD_N`, `HARD_MAX_TRAVEL_MM` | Limits the controller never exceeds, whatever the app sends. |
| `HOMING_SPEED_MM_S`, `HOMING_BACKOFF_MM_S` | Homing speeds. |

Speeds, travel distance, load capacity and height capacity are set in the app and sent over Modbus; they are not in `config.h`.

## Upload

1. Install the [Arduino IDE](https://www.arduino.cc/en/software).
2. Open `firmware/pltm-controller/pltm-controller.ino`. The IDE opens the other files in the folder with it.
3. **Tools → Board**: *Arduino Mega or Mega 2560* (or *Arduino Uno*). **Tools → Port**: the Arduino's COM port.
4. Click **Upload**.

No libraries are needed.

## Connecting the app

In the app, SETTINGS → CONNECTION:

| Setting | Value |
| --- | --- |
| DRIVER | Modbus |
| PROTOCOL | Modbus RTU — serial |
| COM PORT | the Arduino's port (USB) or the RS-485 adapter's port |
| BAUD RATE | 9600, DATA / PARITY / STOP 8 / None / 1 |
| SLAVE ID | 1 |
| REGISTER MAP | leave as shipped |

Press **TEST CONNECTION**: it should read *HOMING NOT DONE*.

### USB auto-reset

An Arduino on USB **restarts every time the app opens the COM port** (the USB chip pulses RESET). The controller then forgets that it was homed, and the first second of requests gets no answer while it boots. That is fine on the bench. On the machine, use one of:

- **RS-485 (recommended):** set `MODBUS_USE_RS485 1`, wire a MAX485 module to Serial1, and connect the PC with a USB-to-RS485 adapter. RS-485 also copes with long cables and electrical noise from the drive.
- Or stop the auto-reset: a 10 µF capacitor between RESET and GND (remove it to upload), or cut the *RESET-EN* jumper on boards that have one.

## How it behaves

| App command | Controller |
| --- | --- |
| HOMING | Drives down at `HOMING_SPEED_MM_S` until the home switch closes, backs off slowly until it opens, and sets that point as 0 mm → READY. |
| START | From READY (homed): rises to the model's travel distance, shows RAISING COMPLETED for `TOP_DWELL_MS`, returns to 0 → READY. From HALT: resumes. |
| STOP | Quick stop → HALT. START resumes. |
| RESET | Clears latched faults (unless the cause is still there), stops motion. Cannot clear a pressed E-stop. |
| Jog UP / DOWN | Hold-to-run in MANUAL mode only. Pendant buttons jog as well. |
| AUTO / MANUAL | Hold both pendant buttons for 5 s (not while moving). |

Safety functions (see [`docs/plc-safety-requirements.md`](../docs/plc-safety-requirements.md)):

| Function | Controller behaviour |
| --- | --- |
| E-stop | Drive disabled, EMERGENCY PRESSED, latched. Needs release **and** RESET; nothing restarts on release. |
| Overload | Above the app's load capacity (never above `HARD_MAX_LOAD_N`): quick stop, OVERLOAD, latched until RESET. |
| Over-travel | Upper/lower switch, or the app's height capacity as a soft limit: quick stop, OVER TRAVEL in the app, latched until RESET. Afterwards only jogging away is allowed. |
| Watchdog | If the app's heartbeat stops for 2 s, motion the app started stops (HALT). Pendant jogging still works. |
| Drive alarm | Drive disabled, SERVO ERROR, latched until RESET. |
| Power-up | Never moves: starts in HOMING NOT DONE. |

## Testing without the machine

The machine logic (`Controller.cpp`, `ModbusSlave.cpp`) has no Arduino code in it. `firmware/host/sim.cpp` runs it on a Mac or Linux PC with a simulated pantograph and serves Modbus on a virtual COM port. `npm run test:firmware` builds it and drives it with the app's real Modbus driver: homing, the full test cycle, stop/resume, and every safety function. It needs `g++` or `clang++`.

To try the app against the simulator by hand:

```bash
g++ -std=c++17 -O2 -Ifirmware/pltm-controller firmware/host/sim.cpp firmware/pltm-controller/Controller.cpp firmware/pltm-controller/ModbusSlave.cpp -o pltm-sim
./pltm-sim
```

It prints the virtual port (e.g. `PTY /dev/ttys004`); enter that as the COM port in the app. Type `estop 1`, `load 300`, `upper 1`, `pendant 1 1` and so on into the simulator to trigger faults (the list is at the top of `sim.cpp`).

## Commissioning on the machine

Do these with the motor **disconnected from the mechanism** first, then with it coupled. Each must pass before use.

1. **Direction and scale:** in MANUAL, jog UP 100 mm in the app; measure the travel. Fix `DIR_UP_HIGH` / `STEPS_PER_MM`.
2. **Homing:** HOMING stops at the home switch, and the app reads 0 mm.
3. **E-stop:** press it while jogging and during a test: the motor loses power at once (hard-wired circuit) and the app shows EMERGENCY PRESSED. Releasing it does not restart anything.
4. **Over-travel switches:** trip each by hand: OVER TRAVEL in the app; jogging into the switch is refused, away from it works after RESET.
5. **Overload:** press on the load cell (or lower the load capacity in the app below the static force): OVERLOAD, motion stops.
6. **Watchdog:** during a test, pull the PC's cable: the machine halts within about 2 s.
7. **Load-cell calibration:** SETTINGS → CALIBRATION in the app, with reference weights.
