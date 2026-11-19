#include "ModbusSlave.h"

namespace pltm {

namespace {

// A gap this long between bytes starts a new frame (more than the 3.5
// character times of the standard at 9600 baud, and tolerant of USB serial,
// which delivers bytes in bursts).
const uint32_t FRAME_GAP_MS = 10;

const uint8_t ILLEGAL_FUNCTION = 1;
const uint8_t ILLEGAL_ADDRESS = 2;
const uint8_t ILLEGAL_VALUE = 3;

uint16_t word(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }

}  // namespace

ModbusSlave::ModbusSlave(RegisterBank &bank, uint8_t unitId)
    : bank_(bank), unitId_(unitId), length_(0), lastByteMs_(0), requests_(0), crcErrors_(0) {}

uint16_t ModbusSlave::crc16(const uint8_t *data, uint16_t length) {
  uint16_t crc = 0xffff;
  for (uint16_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

/** Request length from the bytes so far; 0 while not yet known. */
uint16_t ModbusSlave::expectedLength() const {
  if (length_ < 2) return 0;
  uint8_t function = frame_[1];
  if (function >= 1 && function <= 6) return 8;
  if (function == 15 || function == 16) return length_ < 7 ? 0 : 9 + frame_[6];
  return 4;  // unknown function: unit, function, CRC
}

uint16_t ModbusSlave::receive(uint8_t byte, uint32_t nowMs, uint8_t *response) {
  if (length_ > 0 && nowMs - lastByteMs_ > FRAME_GAP_MS) length_ = 0;  // stale partial frame
  lastByteMs_ = nowMs;
  if (length_ >= MAX_FRAME) length_ = 0;
  frame_[length_++] = byte;

  uint16_t expected = expectedLength();
  if (expected == 0 || length_ < expected) return 0;
  if (expected > MAX_FRAME) {
    length_ = 0;
    return 0;
  }
  uint16_t received = (uint16_t)(frame_[expected - 2] | (frame_[expected - 1] << 8));
  bool crcOk = received == crc16(frame_, expected - 2);
  uint8_t unit = frame_[0];
  length_ = 0;
  if (!crcOk) {
    crcErrors_++;
    return 0;  // corrupt frame: the standard says stay silent
  }
  if (unit != unitId_ && unit != 0) return 0;
  requests_++;
  uint16_t size = handle(response);
  if (unit == 0) return 0;  // broadcast: act, but never reply
  uint16_t crc = crc16(response, size);
  response[size++] = crc & 0xff;
  response[size++] = crc >> 8;
  return size;
}

uint16_t ModbusSlave::exception(uint8_t *response, uint8_t function, uint8_t code) {
  response[0] = unitId_;
  response[1] = function | 0x80;
  response[2] = code;
  return 3;
}

/** Executes the request in frame_ and writes the response (without CRC). */
uint16_t ModbusSlave::handle(uint8_t *response) {
  const uint8_t function = frame_[1];
  const uint16_t address = word(frame_ + 2);
  const uint16_t count = word(frame_ + 4);
  response[0] = unitId_;
  response[1] = function;

  switch (function) {
    case 1:    // read coils
    case 2: {  // read discrete inputs
      if (count < 1 || count > 2000) return exception(response, function, ILLEGAL_VALUE);
      uint16_t bytes = (count + 7) / 8;
      if (3 + bytes + 2 > MAX_FRAME) return exception(response, function, ILLEGAL_VALUE);
      response[2] = (uint8_t)bytes;
      for (uint16_t i = 0; i < bytes; i++) response[3 + i] = 0;
      for (uint16_t i = 0; i < count; i++) {
        bool bit;
        bool ok = function == 1 ? bank_.readCoil(address + i, bit) : bank_.readDiscrete(address + i, bit);
        if (!ok) return exception(response, function, ILLEGAL_ADDRESS);
        if (bit) response[3 + i / 8] |= (uint8_t)(1 << (i % 8));
      }
      return 3 + bytes;
    }
    case 3:    // read holding registers
    case 4: {  // read input registers
      if (count < 1 || count > 125) return exception(response, function, ILLEGAL_VALUE);
      response[2] = (uint8_t)(count * 2);
      for (uint16_t i = 0; i < count; i++) {
        uint16_t value;
        bool ok = function == 3 ? bank_.readHolding(address + i, value) : bank_.readInput(address + i, value);
        if (!ok) return exception(response, function, ILLEGAL_ADDRESS);
        response[3 + i * 2] = value >> 8;
        response[4 + i * 2] = value & 0xff;
      }
      return 3 + count * 2;
    }
    case 5: {  // write single coil: 0xFF00 on, 0x0000 off
      if (count != 0xff00 && count != 0x0000) return exception(response, function, ILLEGAL_VALUE);
      if (!bank_.writeCoil(address, count == 0xff00)) return exception(response, function, ILLEGAL_ADDRESS);
      for (uint8_t i = 2; i < 6; i++) response[i] = frame_[i];
      return 6;
    }
    case 6: {  // write single register
      if (!bank_.writeHolding(address, count)) return exception(response, function, ILLEGAL_ADDRESS);
      for (uint8_t i = 2; i < 6; i++) response[i] = frame_[i];
      return 6;
    }
    case 15: {  // write multiple coils
      uint8_t bytes = frame_[6];
      if (count < 1 || count > 1968 || bytes != (count + 7) / 8) return exception(response, function, ILLEGAL_VALUE);
      for (uint16_t i = 0; i < count; i++) {
        bool bit = (frame_[7 + i / 8] >> (i % 8)) & 1;
        if (!bank_.writeCoil(address + i, bit)) return exception(response, function, ILLEGAL_ADDRESS);
      }
      for (uint8_t i = 2; i < 6; i++) response[i] = frame_[i];
      return 6;
    }
    case 16: {  // write multiple registers
      uint8_t bytes = frame_[6];
      if (count < 1 || count > 123 || bytes != count * 2) return exception(response, function, ILLEGAL_VALUE);
      // Check every address first so a bad request changes nothing.
      for (uint16_t i = 0; i < count; i++) {
        uint16_t probe;
        if (!bank_.readHolding(address + i, probe)) return exception(response, function, ILLEGAL_ADDRESS);
      }
      for (uint16_t i = 0; i < count; i++) bank_.writeHolding(address + i, word(frame_ + 7 + i * 2));
      for (uint8_t i = 2; i < 6; i++) response[i] = frame_[i];
      return 6;
    }
    default:
      return exception(response, function, ILLEGAL_FUNCTION);
  }
}

}  // namespace pltm
