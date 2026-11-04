// Host simulator for the PLTM controller firmware (Linux / macOS).
//
// Runs the firmware's own Controller and ModbusSlave code against a simulated
// pantograph, and serves Modbus RTU on a pseudo-terminal that the PLTM HMI app
// (or any Modbus tool) opens like a COM port. Used by `npm run test:firmware`;
// also handy for trying the firmware with the app before the machine exists.
//
//   ./pltm-sim [--pos <mm above home>]
//
// Prints "PTY <path>" once ready. Commands on stdin, one per line:
//   estop 0|1        press / release the E-stop
//   load <N>|auto    force the load-cell reading, or back to the model
//   upper 0|1        force the upper over-travel switch
//   lower 0|1        force the lower over-travel switch
//   alarm 0|1        drive alarm
//   pendant <up> <down>   hold pendant buttons (0/1 each)
//   noise <bytes>    send garbage bytes to the line before the next request
//   state            print the controller state as one JSON line
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#include <chrono>
#include <cmath>
#include <string>
#include <thread>

#include "Controller.h"
#include "ModbusSlave.h"
#include "config.h"

namespace {

uint32_t nowMs() {
  using namespace std::chrono;
  static const auto start = steady_clock::now();
  return (uint32_t)duration_cast<milliseconds>(steady_clock::now() - start).count();
}

const char *safetyName(pltm::SafetyStop s) {
  switch (s) {
    case pltm::SafetyStop::None: return "none";
    case pltm::SafetyStop::Estop: return "estop";
    case pltm::SafetyStop::Overload: return "overload";
    case pltm::SafetyStop::Travel: return "travel";
    case pltm::SafetyStop::Watchdog: return "watchdog";
    case pltm::SafetyStop::DriveAlarm: return "drive-alarm";
    case pltm::SafetyStop::HomingFailed: return "homing-failed";
  }
  return "?";
}

}  // namespace

int main(int argc, char **argv) {
  // Physical pantograph position, mm above the point where the home switch opens.
  double physical = 150;
  for (int i = 1; i + 1 < argc; i++) {
    if (!strcmp(argv[i], "--pos")) physical = atof(argv[i + 1]);
  }
  const double upperSwitchMm = 4150;   // upper over-travel switch
  const double lowerSwitchMm = -40;    // lower over-travel switch
  const double homeSwitchMm = 0;       // home switch made at or below this

  int master = posix_openpt(O_RDWR | O_NOCTTY);
  if (master < 0 || grantpt(master) || unlockpt(master)) {
    perror("pty");
    return 1;
  }
  const char *slavePath = ptsname(master);
  // Hold the slave end open in raw mode so the line stays up between app
  // connections and nothing is echoed back.
  int slave = open(slavePath, O_RDWR | O_NOCTTY);
  termios tio;
  tcgetattr(slave, &tio);
  cfmakeraw(&tio);
  tcsetattr(slave, TCSANOW, &tio);
  fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK);
  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
  setvbuf(stdout, nullptr, _IOLBF, 0);
  printf("PTY %s\n", slavePath);

  pltm::Controller controller;
  pltm::ModbusSlave modbus(controller, MODBUS_UNIT_ID);
  uint8_t response[pltm::ModbusSlave::MAX_FRAME];

  bool estop = false, upperForced = false, lowerForced = false, alarm = false;
  bool pendantUp = false, pendantDown = false;
  double loadOverride = NAN;
  double zeroOffset = physical;  // controller position = physical - zeroOffset
  double velocity = 0;
  bool drive = false;
  int noiseBytes = 0;
  std::string line;
  uint32_t last = nowMs();
  unsigned seed = 1;

  for (;;) {
    // Modbus bytes from the app.
    uint8_t buffer[256];
    ssize_t n = read(master, buffer, sizeof(buffer));
    for (ssize_t i = 0; i < n; i++) {
      uint16_t length = modbus.receive(buffer[i], nowMs(), response);
      if (length) {
        if (noiseBytes) {
          uint8_t junk[16] = {0x55, 0xaa, 0x01, 0x03, 0xff, 0x00, 0x12, 0x34};
          (void)!write(master, junk, noiseBytes > 16 ? 16 : noiseBytes);
          noiseBytes = 0;
        }
        (void)!write(master, response, length);
      }
    }

    // Test commands.
    char c;
    ssize_t got;
    while ((got = read(STDIN_FILENO, &c, 1)) == 1) {
      if (c != '\n') {
        line += c;
        continue;
      }
      char word[16] = {0};
      double a = 0, b = 0;
      int fields = sscanf(line.c_str(), "%15s %lf %lf", word, &a, &b);
      std::string cmd = word;
      if (cmd == "estop") estop = a != 0;
      else if (cmd == "upper") upperForced = a != 0;
      else if (cmd == "lower") lowerForced = a != 0;
      else if (cmd == "alarm") alarm = a != 0;
      else if (cmd == "pendant") pendantUp = a != 0, pendantDown = b != 0;
      else if (cmd == "noise") noiseBytes = (int)a;
      else if (cmd == "load") loadOverride = fields >= 2 ? a : NAN;
      else if (cmd == "state") {
        unsigned coils = 0;
        for (uint16_t i = 0; i < 8; i++) {
          bool bit = false;
          controller.readCoil(i, bit);
          if (bit) coils |= 1u << i;
        }
        uint16_t heartbeat = 0;
        controller.readHolding(reg::HEARTBEAT, heartbeat);
        printf(
            "{\"status\":%u,\"position\":%.2f,\"physical\":%.2f,\"velocity\":%.2f,\"homed\":%s,"
            "\"manual\":%s,\"drive\":%s,\"safetyStop\":\"%s\",\"requests\":%u,\"crcErrors\":%u,"
            "\"coils\":%u,\"heartbeat\":%u}\n",
            controller.status(), physical - zeroOffset, physical, velocity, controller.homed() ? "true" : "false",
            controller.manualMode() ? "true" : "false", drive ? "true" : "false",
            safetyName(controller.lastSafetyStop()), (unsigned)modbus.requests(), (unsigned)modbus.crcErrors(), coils,
            (unsigned)heartbeat);
      }
      line.clear();
    }
    if (got == 0) return 0;  // stdin closed: the test (or terminal) has gone

    // One control cycle per millisecond, like the Arduino.
    uint32_t now = nowMs();
    if (now != last) {
      double dt = (now - last) / 1000.0;
      last = now;
      if (drive) physical += velocity * dt;  // an ideal drive: no lost steps

      pltm::Inputs in;
      in.nowMs = now;
      bool moving = velocity != 0;
      seed = seed * 1103515245u + 12345u;
      double noise = ((seed >> 16) & 0xff) / 255.0;
      // Contact force rises slightly with height while the pantograph moves.
      in.loadN = (float)(std::isnan(loadOverride) ? (moving ? 60 + 0.004 * physical + noise : 0) : loadOverride);
      in.loadValid = true;
      in.positionMm = (float)(physical - zeroOffset);
      in.estop = estop;
      in.homeSwitch = physical <= homeSwitchMm;
      in.upperLimit = upperForced || physical >= upperSwitchMm;
      in.lowerLimit = lowerForced || physical <= lowerSwitchMm;
      in.driveAlarm = alarm;
      in.pendantUp = pendantUp;
      in.pendantDown = pendantDown;

      pltm::Outputs out = controller.update(in);
      if (out.zeroPosition) zeroOffset = physical;
      drive = out.driveEnable;
      velocity = drive ? out.velocityMmS : 0;
    }

    pollfd fds[2] = {{master, POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
    poll(fds, 2, 1);
  }
}
