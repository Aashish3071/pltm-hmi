// Modbus register layout. Matches DEFAULT_REGISTER_MAP in
// src/main/hardware/config.ts, so the app works with this controller without
// editing the register map. Addresses are 0-based (as in the app).
#pragma once

#include <stdint.h>

namespace reg {

// Coils (FC 1 read, FC 5 / 15 write)
enum Coil : uint8_t {
  START = 0,   // pulse: start the test, or resume after STOP
  STOP = 1,    // pulse: halt
  RESET = 2,   // pulse: clear faults; stops motion
  HOME = 3,    // pulse: run the homing sequence
  JOG_UP = 4,  // level: jog up while 1 (MANUAL mode)
  JOG_DOWN = 5,
  COIL_COUNT = 16
};

// Discrete inputs (FC 2)
enum Discrete : uint8_t {
  HOMED = 0,
  ESTOP = 1,          // 1 while the E-stop is pressed
  OVERLOAD_TRIP = 2,  // latched until RESET
  UPPER_LIMIT = 3,    // upper switch or soft travel limit; latched until RESET
  LOWER_LIMIT = 4,    // lower over-travel switch; latched until RESET
  DISCRETE_COUNT = 16
};

// Holding registers (FC 3 read, FC 6 / 16 write)
enum Holding : uint8_t {
  UP_SPEED = 0,        // mm/s x 10
  DOWN_SPEED = 1,      // mm/s x 10
  JOG_SPEED = 2,       // mm/s x 10
  TRAVEL_DISTANCE = 3, // mm
  OVERLOAD_LIMIT = 4,  // N x 10
  TRAVEL_LIMIT = 5,    // mm
  HEARTBEAT = 6,       // counter written by the app every 500 ms
  HOLDING_COUNT = 16
};

// Input registers (FC 4)
enum Input : uint8_t {
  LOAD_HI = 0,   // int32 big-endian word order, N x 100
  LOAD_LO = 1,
  POS_HI = 2,    // int32, mm x 100
  POS_LO = 3,
  STATUS = 4,    // see Status
  MODE = 5,      // 0 AUTO, 1 MANUAL
  INPUT_COUNT = 16
};

// Status codes: statusCodes in the app's register map.
enum Status : uint16_t {
  HOMING_NOT_DONE = 0,
  READY = 1,
  RAISING = 2,
  RAISING_COMPLETED = 3,
  RETRIEVING = 4,
  HALT = 5,
  EMERGENCY = 10,
  DRIVE_ERROR = 11,
  OVERLOAD = 12
};

}  // namespace reg
