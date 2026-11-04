// Modbus RTU slave: frames bytes from the serial line, checks the CRC, and
// answers function codes 1-6, 15 and 16 from a RegisterBank. No Arduino
// dependencies; the sketch feeds it bytes and sends what it returns.
#pragma once

#include <stdint.h>

#include "Controller.h"

namespace pltm {

class ModbusSlave {
 public:
  static const uint16_t MAX_FRAME = 256;

  ModbusSlave(RegisterBank &bank, uint8_t unitId);

  /**
   * Feeds one received byte. When it completes a request addressed to this
   * unit, returns the length of the response written to `response` (to be
   * sent at once); otherwise 0.
   */
  uint16_t receive(uint8_t byte, uint32_t nowMs, uint8_t *response);

  /** Counters for diagnostics and tests. */
  uint32_t requests() const { return requests_; }
  uint32_t crcErrors() const { return crcErrors_; }

  static uint16_t crc16(const uint8_t *data, uint16_t length);

 private:
  uint16_t expectedLength() const;
  uint16_t handle(uint8_t *response);
  uint16_t exception(uint8_t *response, uint8_t function, uint8_t code);

  RegisterBank &bank_;
  uint8_t unitId_;
  uint8_t frame_[MAX_FRAME];
  uint16_t length_;
  uint32_t lastByteMs_;
  uint32_t requests_;
  uint32_t crcErrors_;
};

}  // namespace pltm
