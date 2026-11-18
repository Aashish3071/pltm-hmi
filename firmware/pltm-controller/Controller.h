// The PLTM controller logic: test cycle, homing, jog, and the safety functions
// of docs/plc-safety-requirements.md. It has no Arduino dependencies: the
// sketch feeds it sensor readings and drives the motor from its output, and the
// host simulator (firmware/host) runs the same code on a PC for testing.
#pragma once

#include <stdint.h>

#include "Registers.h"

namespace pltm {

/** What the sketch measured this cycle. */
struct Inputs {
  uint32_t nowMs;
  float loadN;
  bool loadValid;     // false until the load cell has given a first reading
  float positionMm;   // from the drive's step count; 0 = home after homing
  bool estop;         // E-stop pressed
  bool homeSwitch;    // home switch made
  bool upperLimit;    // upper over-travel switch tripped
  bool lowerLimit;    // lower over-travel switch tripped
  bool driveAlarm;    // drive reports a fault
  bool pendantUp;     // pendant buttons held
  bool pendantDown;
};

/** What the sketch must do this cycle. */
struct Outputs {
  float velocityMmS;  // signed: + is up
  bool driveEnable;
  bool zeroPosition;  // set the step counter to 0 now (end of homing)
};

/** Why motion was last stopped by a safety function (for logs and tests). */
enum class SafetyStop : uint8_t { None, Estop, Overload, Travel, Watchdog, DriveAlarm, HomingFailed };

/** Register access for the Modbus slave. Return false for an illegal address. */
class RegisterBank {
 public:
  virtual bool readCoil(uint16_t address, bool &value) = 0;
  virtual bool readDiscrete(uint16_t address, bool &value) = 0;
  virtual bool readHolding(uint16_t address, uint16_t &value) = 0;
  virtual bool readInput(uint16_t address, uint16_t &value) = 0;
  virtual bool writeCoil(uint16_t address, bool value) = 0;
  virtual bool writeHolding(uint16_t address, uint16_t value) = 0;
};

class Controller : public RegisterBank {
 public:
  Controller();

  /** Runs one control cycle; call every millisecond or so. */
  Outputs update(const Inputs &in);

  uint16_t status() const { return status_; }
  bool homed() const { return homed_; }
  bool manualMode() const { return manual_; }
  SafetyStop lastSafetyStop() const { return lastSafetyStop_; }

  bool readCoil(uint16_t address, bool &value) override;
  bool readDiscrete(uint16_t address, bool &value) override;
  bool readHolding(uint16_t address, uint16_t &value) override;
  bool readInput(uint16_t address, uint16_t &value) override;
  bool writeCoil(uint16_t address, bool value) override;
  bool writeHolding(uint16_t address, uint16_t value) override;

 private:
  enum class Homing : uint8_t { Off, Seeking, BackingOff };

  void onPulse(uint8_t coil);
  void start();
  void stop();
  void reset();
  void home();
  void safetyStop(SafetyStop why, uint16_t newStatus);
  void abortHoming();
  bool faulted() const;
  bool autoMoving() const;
  bool moving() const;
  float targetVelocity(const Inputs &in);
  float approach(float maxSpeed, float distance) const;
  void handlePendant(const Inputs &in);
  void syncInputs(const Inputs &in);

  float upSpeed() const;
  float downSpeed() const;
  float jogSpeed() const;
  float travelMm() const { return holding_[reg::TRAVEL_DISTANCE]; }
  float overloadLimitN() const;
  float travelLimitMm() const;

  bool coils_[reg::COIL_COUNT];
  uint16_t holding_[reg::HOLDING_COUNT];
  uint16_t input_[reg::INPUT_COUNT];

  uint16_t status_;
  uint16_t haltedFrom_;     // RAISING or RETRIEVING, to resume after STOP
  bool homed_;
  bool manual_;
  bool overloadTrip_;
  bool upperTrip_;
  bool lowerTrip_;
  bool estop_;
  Homing homing_;
  float homingStartMm_;
  bool homeSwitchUsed_;
  bool zeroRequest_;

  float velocity_;
  bool quickStop_;
  uint32_t lastMs_;
  uint32_t dwellStartMs_;
  uint16_t lastHeartbeat_;
  uint32_t heartbeatChangedMs_;
  uint32_t bothPendantSinceMs_;
  bool pendantToggleDone_;
  SafetyStop lastSafetyStop_;
  bool started_;
};

}  // namespace pltm
