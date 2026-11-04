#include "Controller.h"

#include <math.h>
#include <string.h>

#include "config.h"

namespace pltm {

namespace {

const float ARRIVED_MM = 0.05f;

float minf(float a, float b) { return a < b ? a : b; }
float maxf(float a, float b) { return a > b ? a : b; }
float absf(float a) { return a < 0 ? -a : a; }

int32_t roundToInt(float value) { return (int32_t)(value < 0 ? value - 0.5f : value + 0.5f); }

}  // namespace

Controller::Controller()
    : status_(reg::HOMING_NOT_DONE),
      haltedFrom_(reg::RAISING),
      homed_(false),
      manual_(false),
      overloadTrip_(false),
      upperTrip_(false),
      lowerTrip_(false),
      estop_(false),
      homing_(Homing::Off),
      homingStartMm_(0),
      homeSwitchUsed_(HOME_SWITCH_PIN >= 0),
      zeroRequest_(false),
      velocity_(0),
      quickStop_(false),
      lastMs_(0),
      dwellStartMs_(0),
      lastHeartbeat_(0),
      heartbeatChangedMs_(0),
      bothPendantSinceMs_(0),
      pendantToggleDone_(false),
      lastSafetyStop_(SafetyStop::None),
      started_(false) {
  memset(coils_, 0, sizeof(coils_));
  memset(holding_, 0, sizeof(holding_));
  memset(input_, 0, sizeof(input_));
}

// --- speeds and limits from the app (raw register values) --------------------

float Controller::upSpeed() const {
  return holding_[reg::UP_SPEED] ? holding_[reg::UP_SPEED] * 0.1f : DEFAULT_UP_SPEED_MM_S;
}

float Controller::downSpeed() const {
  return holding_[reg::DOWN_SPEED] ? holding_[reg::DOWN_SPEED] * 0.1f : DEFAULT_DOWN_SPEED_MM_S;
}

float Controller::jogSpeed() const {
  return holding_[reg::JOG_SPEED] ? holding_[reg::JOG_SPEED] * 0.1f : DEFAULT_JOG_SPEED_MM_S;
}

/** The app's overload limit, never above the controller's hard maximum. */
float Controller::overloadLimitN() const {
  float app = holding_[reg::OVERLOAD_LIMIT] * 0.1f;
  return app > 0 ? minf(app, HARD_MAX_LOAD_N) : HARD_MAX_LOAD_N;
}

/** The app's soft travel limit, never above the controller's hard maximum. */
float Controller::travelLimitMm() const {
  float app = holding_[reg::TRAVEL_LIMIT];
  return app > 0 ? minf(app, HARD_MAX_TRAVEL_MM) : HARD_MAX_TRAVEL_MM;
}

// --- state helpers -----------------------------------------------------------

bool Controller::faulted() const {
  return status_ == reg::EMERGENCY || status_ == reg::DRIVE_ERROR || status_ == reg::OVERLOAD;
}

bool Controller::autoMoving() const {
  return status_ == reg::RAISING || status_ == reg::RAISING_COMPLETED || status_ == reg::RETRIEVING;
}

bool Controller::moving() const { return velocity_ != 0 || autoMoving() || homing_ != Homing::Off; }

/** Fastest speed that can still stop within `distance` at the normal deceleration. */
float Controller::approach(float maxSpeed, float distance) const {
  if (distance <= 0) return 0;
  return minf(maxSpeed, sqrtf(2.0f * ACCEL_MM_S2 * distance));
}

void Controller::safetyStop(SafetyStop why, uint16_t newStatus) {
  coils_[reg::JOG_UP] = false;
  coils_[reg::JOG_DOWN] = false;
  if (status_ == reg::RAISING || status_ == reg::RETRIEVING) haltedFrom_ = status_;
  if (status_ == reg::RAISING_COMPLETED) haltedFrom_ = reg::RETRIEVING;
  if (homing_ != Homing::Off) abortHoming();
  status_ = newStatus;
  quickStop_ = true;
  lastSafetyStop_ = why;
}

void Controller::abortHoming() {
  homing_ = Homing::Off;
  homed_ = false;
  if (!faulted()) status_ = reg::HOMING_NOT_DONE;
}

// --- commands ----------------------------------------------------------------

void Controller::start() {
  if (faulted() || estop_ || upperTrip_ || lowerTrip_ || manual_ || homing_ != Homing::Off) return;
  if (status_ == reg::READY && homed_ && travelMm() > 0) {
    status_ = reg::RAISING;
    quickStop_ = false;
  } else if (status_ == reg::HALT && homed_) {
    status_ = haltedFrom_;
    quickStop_ = false;
  }
}

void Controller::stop() {
  if (homing_ != Homing::Off) {
    abortHoming();
    quickStop_ = true;
    return;
  }
  if (autoMoving()) {
    haltedFrom_ = status_ == reg::RAISING ? reg::RAISING : reg::RETRIEVING;
    status_ = reg::HALT;
    quickStop_ = true;
  }
}

void Controller::reset() {
  // A pressed E-stop cannot be reset away: it must be released first.
  if (estop_) return;
  if (homing_ != Homing::Off) abortHoming();
  overloadTrip_ = false;
  upperTrip_ = false;
  lowerTrip_ = false;
  coils_[reg::JOG_UP] = false;
  coils_[reg::JOG_DOWN] = false;
  status_ = homed_ ? reg::READY : reg::HOMING_NOT_DONE;
  quickStop_ = true;
  // Any condition still present (switch held, load still high, drive alarm)
  // trips again on the next cycle.
}

void Controller::home() {
  if (faulted() || estop_ || autoMoving() || status_ == reg::HALT || homing_ != Homing::Off) return;
  if (!homeSwitchUsed_) {
    // No home switch fitted: the current position becomes 0, as on a machine
    // homed by eye.
    zeroRequest_ = true;
    homed_ = true;
    status_ = reg::READY;
    return;
  }
  homed_ = false;
  status_ = reg::HOMING_NOT_DONE;
  homing_ = Homing::Seeking;
  homingStartMm_ = NAN;  // set on the next update from the measured position
  quickStop_ = false;
}

void Controller::onPulse(uint8_t coil) {
  switch (coil) {
    case reg::START: start(); break;
    case reg::STOP: stop(); break;
    case reg::RESET: reset(); break;
    case reg::HOME: home(); break;
    default: break;
  }
}

// --- the control cycle -------------------------------------------------------

void Controller::handlePendant(const Inputs &in) {
  if (in.pendantUp && in.pendantDown) {
    if (!bothPendantSinceMs_) bothPendantSinceMs_ = in.nowMs ? in.nowMs : 1;
    bool idle = !moving() && !autoMoving() && homing_ == Homing::Off;
    if (!pendantToggleDone_ && idle && in.nowMs - bothPendantSinceMs_ >= PENDANT_MODE_HOLD_MS) {
      manual_ = !manual_;
      coils_[reg::JOG_UP] = false;
      coils_[reg::JOG_DOWN] = false;
      pendantToggleDone_ = true;  // release both before the next change
    }
  } else {
    bothPendantSinceMs_ = 0;
    if (!in.pendantUp && !in.pendantDown) pendantToggleDone_ = false;
  }
}

float Controller::targetVelocity(const Inputs &in) {
  const float pos = in.positionMm;

  if (homing_ == Homing::Seeking) {
    if (in.homeSwitch) {
      homing_ = Homing::BackingOff;
    } else {
      return -HOMING_SPEED_MM_S;
    }
  }
  if (homing_ == Homing::BackingOff) {
    if (in.homeSwitch) return HOMING_BACKOFF_MM_S;
    // Switch just opened: this is 0 mm.
    homing_ = Homing::Off;
    zeroRequest_ = true;
    homed_ = true;
    status_ = reg::READY;
    velocity_ = 0;
    return 0;
  }

  switch (status_) {
    case reg::RAISING: {
      float distance = travelMm() - pos;
      if (distance <= ARRIVED_MM) {
        velocity_ = 0;
        status_ = reg::RAISING_COMPLETED;
        dwellStartMs_ = in.nowMs;
        return 0;
      }
      return approach(upSpeed(), distance);
    }
    case reg::RAISING_COMPLETED:
      if (in.nowMs - dwellStartMs_ >= TOP_DWELL_MS) status_ = reg::RETRIEVING;
      return 0;
    case reg::RETRIEVING: {
      if (pos <= ARRIVED_MM) {
        velocity_ = 0;
        status_ = reg::READY;
        return 0;
      }
      return -approach(downSpeed(), pos);
    }
    default:
      break;
  }

  if (!manual_ || faulted() || estop_) return 0;

  // MANUAL: hold-to-run jog from the app (coils) or the pendant buttons.
  bool both = in.pendantUp && in.pendantDown;
  bool up = !both && (coils_[reg::JOG_UP] || in.pendantUp);
  bool down = !both && (coils_[reg::JOG_DOWN] || in.pendantDown);
  if (up && !down) {
    // Only jogging away from a tripped limit. Running into the soft limit
    // trips OVER TRAVEL (quick stop), so the operator sees why it stopped.
    if (upperTrip_) return 0;
    return jogSpeed();
  }
  if (down && !up) {
    if (lowerTrip_) return 0;
    // Once homed, 0 mm is the bottom of the working range.
    return homed_ ? -approach(jogSpeed(), pos) : -jogSpeed();
  }
  return 0;
}

Outputs Controller::update(const Inputs &in) {
  if (!started_) {
    started_ = true;
    lastMs_ = in.nowMs;
    heartbeatChangedMs_ = in.nowMs;
  }
  float dt = (in.nowMs - lastMs_) / 1000.0f;
  lastMs_ = in.nowMs;
  if (dt < 0 || dt > 0.1f) dt = 0.1f;

  if (holding_[reg::HEARTBEAT] != lastHeartbeat_) {
    lastHeartbeat_ = holding_[reg::HEARTBEAT];
    heartbeatChangedMs_ = in.nowMs;
  }
  if (homing_ == Homing::Seeking && isnan(homingStartMm_)) homingStartMm_ = in.positionMm;

  // --- safety functions, in order of precedence ---
  estop_ = in.estop;
  if (in.estop) {
    if (status_ != reg::EMERGENCY) safetyStop(SafetyStop::Estop, reg::EMERGENCY);
    velocity_ = 0;  // drive power is cut by the E-stop circuit anyway
  } else if (in.driveAlarm) {
    if (status_ != reg::DRIVE_ERROR && status_ != reg::EMERGENCY) safetyStop(SafetyStop::DriveAlarm, reg::DRIVE_ERROR);
    velocity_ = 0;
  }

  if (in.loadValid && in.loadN > overloadLimitN() && !overloadTrip_) {
    overloadTrip_ = true;
    if (status_ != reg::EMERGENCY && status_ != reg::DRIVE_ERROR) safetyStop(SafetyStop::Overload, reg::OVERLOAD);
  }

  bool goingUp = velocity_ > 0 || status_ == reg::RAISING;
  // Trip early enough that the quick stop ends at the limit, not past it.
  float stoppingMm = velocity_ > 0 ? velocity_ * velocity_ / (2.0f * QUICK_STOP_MM_S2) : 0;
  bool softLimit = homed_ && in.positionMm + stoppingMm >= travelLimitMm() - ARRIVED_MM;
  if (in.upperLimit || (goingUp && softLimit)) {
    if (!upperTrip_ && goingUp) safetyStop(SafetyStop::Travel, autoMoving() ? (uint16_t)reg::HALT : status_);
    upperTrip_ = true;
  }
  if (in.lowerLimit) {
    if (!lowerTrip_ && (velocity_ < 0 || autoMoving() || homing_ != Homing::Off)) {
      safetyStop(SafetyStop::Travel, autoMoving() ? (uint16_t)reg::HALT : status_);
    }
    lowerTrip_ = true;
  }

  if (homing_ != Homing::Off && !isnan(homingStartMm_) &&
      absf(in.positionMm - homingStartMm_) > HOMING_MAX_TRAVEL_MM) {
    safetyStop(SafetyStop::HomingFailed, reg::HOMING_NOT_DONE);
  }

  // Communication watchdog: motion started from the app stops when it goes
  // silent. Pendant jogging works without the PC.
  bool appMotion = autoMoving() || homing_ != Homing::Off || coils_[reg::JOG_UP] || coils_[reg::JOG_DOWN];
  if (appMotion && in.nowMs - heartbeatChangedMs_ > WATCHDOG_MS) {
    safetyStop(SafetyStop::Watchdog, autoMoving() ? (uint16_t)reg::HALT : status_);
  }

  handlePendant(in);

  // --- motion ---
  float target = targetVelocity(in);
  if (faulted() || estop_) target = 0;
  float accel = quickStop_ ? QUICK_STOP_MM_S2 : ACCEL_MM_S2;
  float step = accel * dt;
  if (velocity_ < target) velocity_ = minf(velocity_ + step, target);
  else if (velocity_ > target) velocity_ = maxf(velocity_ - step, target);
  if (velocity_ == 0 && target == 0) quickStop_ = false;

  Outputs out;
  out.velocityMmS = velocity_;
  out.driveEnable = !in.estop && !in.driveAlarm;
  out.zeroPosition = zeroRequest_;
  zeroRequest_ = false;

  syncInputs(in);
  if (out.zeroPosition) {
    input_[reg::POS_HI] = 0;
    input_[reg::POS_LO] = 0;
  }
  return out;
}

void Controller::syncInputs(const Inputs &in) {
  int32_t load = roundToInt(in.loadN * 100.0f);
  int32_t pos = roundToInt(in.positionMm * 100.0f);
  input_[reg::LOAD_HI] = (uint16_t)((uint32_t)load >> 16);
  input_[reg::LOAD_LO] = (uint16_t)((uint32_t)load & 0xffff);
  input_[reg::POS_HI] = (uint16_t)((uint32_t)pos >> 16);
  input_[reg::POS_LO] = (uint16_t)((uint32_t)pos & 0xffff);
  input_[reg::STATUS] = status_;
  input_[reg::MODE] = manual_ ? 1 : 0;
}

// --- Modbus register access ----------------------------------------------------

bool Controller::readCoil(uint16_t address, bool &value) {
  if (address >= reg::COIL_COUNT) return false;
  value = coils_[address];
  return true;
}

bool Controller::readDiscrete(uint16_t address, bool &value) {
  if (address >= reg::DISCRETE_COUNT) return false;
  switch (address) {
    case reg::HOMED: value = homed_; break;
    case reg::ESTOP: value = estop_; break;
    case reg::OVERLOAD_TRIP: value = overloadTrip_; break;
    case reg::UPPER_LIMIT: value = upperTrip_; break;
    case reg::LOWER_LIMIT: value = lowerTrip_; break;
    default: value = false; break;
  }
  return true;
}

bool Controller::readHolding(uint16_t address, uint16_t &value) {
  if (address >= reg::HOLDING_COUNT) return false;
  value = holding_[address];
  return true;
}

bool Controller::readInput(uint16_t address, uint16_t &value) {
  if (address >= reg::INPUT_COUNT) return false;
  value = input_[address];
  return true;
}

bool Controller::writeCoil(uint16_t address, bool value) {
  if (address >= reg::COIL_COUNT) return false;
  bool rising = value && !coils_[address];
  coils_[address] = value;
  // Pulse commands act on the rising edge only.
  if (rising) onPulse((uint8_t)address);
  // Jog is level-sensitive and only in MANUAL mode.
  if ((address == reg::JOG_UP || address == reg::JOG_DOWN) && !manual_) coils_[address] = false;
  return true;
}

bool Controller::writeHolding(uint16_t address, uint16_t value) {
  if (address >= reg::HOLDING_COUNT) return false;
  holding_[address] = value;
  return true;
}

}  // namespace pltm
