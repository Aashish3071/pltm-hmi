// =============================================================================
// PLTM controller: machine settings. Edit this file to match your wiring and
// mechanics, then upload. Everything the operator sets in the PLTM HMI app
// (speeds, travel distance, load and height capacity) comes over Modbus and is
// NOT set here.
// =============================================================================
#pragma once

// --- Modbus link to the PC ---------------------------------------------------
// The app's default is 9600 baud, 8 data bits, no parity, 1 stop bit, slave 1
// (SETTINGS -> CONNECTION). Keep these in step with it.
#define MODBUS_BAUD 9600
#define MODBUS_UNIT_ID 1

// 0: the Arduino's own USB port is the COM port (bench testing).
// 1: an RS-485 module (MAX485 or similar) on Serial1 (pins 18/19 on a Mega),
//    with its DE and /RE pins tied together to RS485_DIR_PIN. Use this on the
//    machine: see "USB auto-reset" in firmware/README.md.
#ifndef MODBUS_USE_RS485
#define MODBUS_USE_RS485 0
#endif
#define RS485_DIR_PIN 2

// --- Motion: step/dir drive (stepper driver, or servo drive in pulse mode) ---
#define STEP_PIN 3
#define DIR_PIN 4
#define ENABLE_PIN 5            // drive enable output; -1 if not wired
#define ENABLE_ACTIVE_LOW 1     // most step/dir drives enable on LOW
#define DIR_UP_HIGH 1           // DIR level that moves the pantograph UP
#define STEPS_PER_MM 80.0f      // drive pulses per mm of pantograph travel
#define STEP_PULSE_US 4         // step pulse width; check the drive's datasheet
#define MAX_STEP_RATE_HZ 40000L // never pulse faster than this

#define ACCEL_MM_S2 400.0f      // normal acceleration and deceleration
#define QUICK_STOP_MM_S2 2000.0f // deceleration for STOP and safety stops

// --- Homing --------------------------------------------------------------------
// HOMING drives down until the home switch closes, backs off slowly until it
// opens again, and sets that point as 0 mm.
#define HOMING_SPEED_MM_S 30.0f
#define HOMING_BACKOFF_MM_S 5.0f
#define HOMING_MAX_TRAVEL_MM 5000.0f // give up (HOMING NOT DONE) after this much travel

// After RAISING reaches the travel distance it shows PANTO RAISING COMPLETED for
// this long before retrieving (0 to go straight down).
#define TOP_DWELL_MS 500

// --- Load cell: HX711 amplifier ---------------------------------------------------
// Wire RATE to VCC for 80 samples/s: at 10 samples/s the overload trip reacts
// eight times slower.
#define HX711_DOUT_PIN 6
#define HX711_SCK_PIN 7
// Rough scale only: the app's load-cell calibration (SETTINGS -> CALIBRATION)
// corrects what the operator sees. The controller's own overload trip uses this
// scale, so set it within a few percent (hang a known weight, read the raw
// value with the serial monitor, see README).
#define LOAD_COUNTS_PER_N 420.0f
#define LOAD_ZERO_COUNTS 0L

// --- Safety ------------------------------------------------------------------------
// The emergency stop must ALSO cut drive power through its own contacts. This
// input only tells the controller and the app that it was pressed.
// Switch inputs use the internal pull-ups; with normally-closed (NC) switches
// wired to GND a broken wire reads as tripped. Set a pin to -1 if not fitted.
#define ESTOP_PIN 8           // NC contact of the E-stop chain
#define HOME_SWITCH_PIN 9     // NO or NC, see HOME_SWITCH_NC
#define HOME_SWITCH_NC 0      // 1 if the home switch is normally closed
#define UPPER_LIMIT_PIN 10    // NC over-travel switch above the working range
#define LOWER_LIMIT_PIN 11    // NC over-travel switch below the home switch
#define DRIVE_ALARM_PIN -1    // drive fault output; -1 if not wired
#define DRIVE_ALARM_ACTIVE_LOW 1

// The controller's own limits, whatever the app writes.
#define HARD_MAX_LOAD_N 600.0f
#define HARD_MAX_TRAVEL_MM 4200.0f

// Communication watchdog: motion started from the app stops if the app's
// heartbeat register has not changed for this long.
#define WATCHDOG_MS 2000

// --- Remote pendant (optional) -----------------------------------------------------
// UP and DOWN push buttons to GND. In MANUAL mode they jog while held. Holding
// both for PENDANT_MODE_HOLD_MS switches between AUTO and MANUAL, as the app
// tells the operator.
#define PENDANT_UP_PIN 12
#define PENDANT_DOWN_PIN 13
#ifndef PENDANT_MODE_HOLD_MS
#define PENDANT_MODE_HOLD_MS 5000
#endif

// Speeds used until the app writes its own (mm/s).
#define DEFAULT_UP_SPEED_MM_S 50.0f
#define DEFAULT_DOWN_SPEED_MM_S 50.0f
#define DEFAULT_JOG_SPEED_MM_S 20.0f
