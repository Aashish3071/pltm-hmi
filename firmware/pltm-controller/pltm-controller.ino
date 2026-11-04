// =============================================================================
// PLTM controller for the Pantograph Load Testing Machine.
//
// A Modbus RTU slave for the PLTM HMI app, using the app's default register
// map, so it works without changing SETTINGS -> CONNECTION -> REGISTER MAP.
// Runs on an Arduino Mega 2560 (recommended) or Uno, both AVR at 16 MHz.
//
// Settings: config.h. Wiring, upload and commissioning: firmware/README.md.
//
// The machine logic is in Controller.cpp and ModbusSlave.cpp and has no
// Arduino code in it; this file connects it to the pins:
//   - Timer1 generates the step pulses at the speed the controller asks for,
//     and counts them as the pantograph position.
//   - The HX711 load-cell amplifier is read whenever it has a sample.
//   - Modbus bytes from the PC are fed to the slave, and replies sent back.
// =============================================================================
#include "Controller.h"
#include "ModbusSlave.h"
#include "config.h"

#if defined(SERIAL_DEBUG)
#define DEBUG_PRINT(x) Serial.println(x)
#else
#define DEBUG_PRINT(x)
#endif

#if MODBUS_USE_RS485
#define MODBUS_PORT Serial1
#else
#define MODBUS_PORT Serial
#endif

pltm::Controller controller;
pltm::ModbusSlave modbus(controller, MODBUS_UNIT_ID);
uint8_t response[pltm::ModbusSlave::MAX_FRAME];

// --- step generation (Timer1) --------------------------------------------------

volatile long stepCount = 0;   // + up; position = stepCount / STEPS_PER_MM
volatile int8_t stepDirection = 0;  // +1 up, -1 down, 0 stopped

ISR(TIMER1_COMPA_vect) {
  if (stepDirection == 0) return;
  digitalWrite(STEP_PIN, HIGH);
  delayMicroseconds(STEP_PULSE_US);
  digitalWrite(STEP_PIN, LOW);
  stepCount += stepDirection;
}

long readSteps() {
  noInterrupts();
  long steps = stepCount;
  interrupts();
  return steps;
}

void zeroSteps() {
  noInterrupts();
  stepCount = 0;
  interrupts();
}

/** Sets the step rate for a velocity in mm/s (+ up). */
void setVelocity(float mmPerS) {
  static int8_t currentDirection = 0;
  long rate = (long)(fabs(mmPerS) * STEPS_PER_MM + 0.5f);
  if (rate > MAX_STEP_RATE_HZ) rate = MAX_STEP_RATE_HZ;
  // Below 31 Hz the 16-bit timer cannot count slowly enough at this prescaler.
  int8_t direction = rate < 31 ? 0 : (mmPerS > 0 ? 1 : -1);

  if (direction != currentDirection) {
    stepDirection = 0;  // stop pulsing while DIR changes
    if (direction != 0) {
      bool up = direction > 0;
      digitalWrite(DIR_PIN, up == (DIR_UP_HIGH != 0) ? HIGH : LOW);
      delayMicroseconds(10);  // DIR setup time before the next step
    }
    currentDirection = direction;
  }
  if (direction == 0) {
    stepDirection = 0;
    return;
  }
  // Timer1 at 2 MHz (prescaler 8): one step every OCR1A + 1 ticks.
  uint16_t top = (uint16_t)(2000000L / rate - 1);
  noInterrupts();
  OCR1A = top;
  if (TCNT1 > top) TCNT1 = 0;
  stepDirection = direction;
  interrupts();
}

void setupStepTimer() {
  noInterrupts();
  TCCR1A = 0;
  TCCR1B = _BV(WGM12) | _BV(CS11);  // CTC mode, prescaler 8
  OCR1A = 65535;
  TIMSK1 = _BV(OCIE1A);
  interrupts();
}

// --- HX711 load-cell amplifier ----------------------------------------------------

long hx711Raw = 0;
bool hx711Valid = false;

/** Reads a sample if one is ready (channel A, gain 128). Takes ~60 us. */
void readHx711() {
  if (digitalRead(HX711_DOUT_PIN) == HIGH) return;  // no new sample yet
  long value = 0;
  for (uint8_t i = 0; i < 24; i++) {
    // SCK must not stay high for more than 60 us or the HX711 powers down,
    // so the step interrupt is held off during each high pulse.
    noInterrupts();
    digitalWrite(HX711_SCK_PIN, HIGH);
    delayMicroseconds(1);
    digitalWrite(HX711_SCK_PIN, LOW);
    interrupts();
    value = (value << 1) | digitalRead(HX711_DOUT_PIN);
  }
  noInterrupts();  // 25th pulse: channel A, gain 128 for the next sample
  digitalWrite(HX711_SCK_PIN, HIGH);
  delayMicroseconds(1);
  digitalWrite(HX711_SCK_PIN, LOW);
  interrupts();
  if (value & 0x800000L) value |= 0xFF000000L;  // sign-extend 24 bits
  hx711Raw = value;
  hx711Valid = true;
}

// --- digital inputs ---------------------------------------------------------------------

/** Reads an input wired to GND with the internal pull-up. -1: not fitted. */
bool closed(int pin) { return pin >= 0 && digitalRead(pin) == LOW; }

/** A normally-closed safety contact: open (or a broken wire) means tripped. */
bool ncTripped(int pin) { return pin >= 0 && digitalRead(pin) == HIGH; }

void inputPin(int pin) {
  if (pin >= 0) pinMode(pin, INPUT_PULLUP);
}

void setDriveEnable(bool enable) {
  if (ENABLE_PIN < 0) return;
  digitalWrite(ENABLE_PIN, (enable != (ENABLE_ACTIVE_LOW != 0)) ? HIGH : LOW);
}

// --- Arduino entry points ------------------------------------------------------------

void setup() {
  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  if (ENABLE_PIN >= 0) pinMode(ENABLE_PIN, OUTPUT);
  setDriveEnable(false);
  pinMode(HX711_SCK_PIN, OUTPUT);
  pinMode(HX711_DOUT_PIN, INPUT);
  inputPin(ESTOP_PIN);
  inputPin(HOME_SWITCH_PIN);
  inputPin(UPPER_LIMIT_PIN);
  inputPin(LOWER_LIMIT_PIN);
  inputPin(DRIVE_ALARM_PIN);
  inputPin(PENDANT_UP_PIN);
  inputPin(PENDANT_DOWN_PIN);
#if MODBUS_USE_RS485
  pinMode(RS485_DIR_PIN, OUTPUT);
  digitalWrite(RS485_DIR_PIN, LOW);  // receive
#endif

  MODBUS_PORT.begin(MODBUS_BAUD);
  setupStepTimer();
  // Powering up never starts motion: the controller starts in HOMING NOT DONE
  // and waits for HOMING, then START, from the app.
}

void sendResponse(uint16_t length) {
#if MODBUS_USE_RS485
  digitalWrite(RS485_DIR_PIN, HIGH);  // transmit
#endif
  MODBUS_PORT.write(response, length);
  MODBUS_PORT.flush();  // wait until the last byte has left
#if MODBUS_USE_RS485
  digitalWrite(RS485_DIR_PIN, LOW);
#endif
}

void loop() {
  uint32_t now = millis();

  while (MODBUS_PORT.available() > 0) {
    uint16_t length = modbus.receive((uint8_t)MODBUS_PORT.read(), now, response);
    if (length) sendResponse(length);
  }

  readHx711();

  static uint32_t lastUpdate = 0;
  if (now == lastUpdate) return;  // run the control cycle once per millisecond
  lastUpdate = now;

  pltm::Inputs in;
  in.nowMs = now;
  in.loadValid = hx711Valid;
  in.loadN = (hx711Raw - LOAD_ZERO_COUNTS) / LOAD_COUNTS_PER_N;
  in.positionMm = readSteps() / STEPS_PER_MM;
  in.estop = ncTripped(ESTOP_PIN);
  in.homeSwitch = HOME_SWITCH_NC ? ncTripped(HOME_SWITCH_PIN) : closed(HOME_SWITCH_PIN);
  in.upperLimit = ncTripped(UPPER_LIMIT_PIN);
  in.lowerLimit = ncTripped(LOWER_LIMIT_PIN);
  in.driveAlarm = DRIVE_ALARM_PIN >= 0 &&
                  (DRIVE_ALARM_ACTIVE_LOW ? digitalRead(DRIVE_ALARM_PIN) == LOW : digitalRead(DRIVE_ALARM_PIN) == HIGH);
  in.pendantUp = closed(PENDANT_UP_PIN);
  in.pendantDown = closed(PENDANT_DOWN_PIN);

  pltm::Outputs out = controller.update(in);
  if (out.zeroPosition) zeroSteps();
  setDriveEnable(out.driveEnable);
  setVelocity(out.driveEnable ? out.velocityMmS : 0);
}
