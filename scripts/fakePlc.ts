/**
 * A minimal fake PLTM PLC for integration tests. It speaks Modbus RTU framing
 * (with CRC-16) over a TCP socket — what a serial-to-Ethernet gateway carries —
 * or Modbus TCP (MBAP), and simulates the pantograph using the addresses of
 * DEFAULT_REGISTER_MAP.
 */
import net from 'net'

export const STATUS = {
  HOMING_NOT_DONE: 0,
  READY: 1,
  RAISING: 2,
  RAISING_COMPLETED: 3,
  RETRIEVING: 4,
  HALT: 5,
  EMERGENCY: 10,
  OVERLOAD: 12
}

export class FakePlc {
  coils = new Array<number>(16).fill(0)
  discrete = new Array<number>(16).fill(0)
  holding = new Array<number>(16).fill(0)
  input = new Array<number>(16).fill(0)

  status = STATUS.HOMING_NOT_DONE
  positionMm = 0
  loadN = 0
  /** Forces the load reading (for overload tests). */
  loadOverrideN: number | null = null
  manualMode = false
  writes = 0
  requests = 0
  private haltedPhase: 'up' | 'down' = 'up'
  private timer: NodeJS.Timeout
  private servers: net.Server[] = []
  private sockets = new Set<net.Socket>()

  constructor(private readonly unitId = 1) {
    this.timer = setInterval(() => this.tick(0.05), 50)
    this.syncInputs()
  }

  get upSpeed(): number {
    return this.holding[0] * 0.1
  }
  get downSpeed(): number {
    return this.holding[1] * 0.1
  }
  get jogSpeed(): number {
    return this.holding[2] * 0.1
  }
  get travelMm(): number {
    return this.holding[3]
  }

  private onCoilWrite(address: number, value: number): void {
    const rising = value && !this.coils[address]
    this.coils[address] = value ? 1 : 0
    if (!rising) return
    switch (address) {
      case 0: // start
        if (this.status === STATUS.READY) this.status = STATUS.RAISING
        else if (this.status === STATUS.HALT) {
          this.status = this.haltedPhase === 'up' ? STATUS.RAISING : STATUS.RETRIEVING
        }
        break
      case 1: // stop
        if (this.status === STATUS.RAISING || this.status === STATUS.RETRIEVING) {
          this.haltedPhase = this.status === STATUS.RAISING ? 'up' : 'down'
          this.status = STATUS.HALT
        }
        break
      case 2: // reset
        this.loadOverrideN = null
        this.status = this.discrete[0] ? STATUS.READY : STATUS.HOMING_NOT_DONE
        break
      case 3: // home
        this.positionMm = 0
        this.discrete[0] = 1
        this.status = STATUS.READY
        break
    }
  }

  private tick(dt: number): void {
    if (this.manualMode) {
      if (this.coils[4]) this.positionMm += this.jogSpeed * dt
      if (this.coils[5]) this.positionMm = Math.max(0, this.positionMm - this.jogSpeed * dt)
    } else if (this.status === STATUS.RAISING) {
      this.positionMm += this.upSpeed * dt
      if (this.positionMm >= this.travelMm) {
        this.positionMm = this.travelMm
        this.status = STATUS.RETRIEVING
      }
    } else if (this.status === STATUS.RETRIEVING) {
      this.positionMm -= this.downSpeed * dt
      if (this.positionMm <= 0) {
        this.positionMm = 0
        this.status = STATUS.READY
      }
    }
    const moving = this.status === STATUS.RAISING || this.status === STATUS.RETRIEVING
    this.loadN = this.loadOverrideN ?? (moving ? 60 + Math.random() : 0)
    this.syncInputs()
  }

  private syncInputs(): void {
    const writeInt32 = (address: number, value: number): void => {
      const buffer = Buffer.alloc(4)
      buffer.writeInt32BE(Math.round(value), 0)
      this.input[address] = buffer.readUInt16BE(0)
      this.input[address + 1] = buffer.readUInt16BE(2)
    }
    writeInt32(0, this.loadN / 0.01)
    writeInt32(2, this.positionMm / 0.01)
    this.input[4] = this.status
    this.input[5] = this.manualMode ? 1 : 0
  }

  /** Executes one request PDU and returns the response PDU. */
  handlePdu(pdu: Buffer): Buffer {
    this.requests++
    const fc = pdu[0]
    const address = pdu.readUInt16BE(1)
    const exception = (code: number): Buffer => Buffer.from([fc | 0x80, code])
    switch (fc) {
      case 1:
      case 2: {
        const count = pdu.readUInt16BE(3)
        const source = fc === 1 ? this.coils : this.discrete
        if (address + count > source.length) return exception(2)
        const bytes = Buffer.alloc(Math.ceil(count / 8))
        for (let i = 0; i < count; i++) if (source[address + i]) bytes[i >> 3] |= 1 << (i & 7)
        return Buffer.concat([Buffer.from([fc, bytes.length]), bytes])
      }
      case 3:
      case 4: {
        const count = pdu.readUInt16BE(3)
        const source = fc === 3 ? this.holding : this.input
        if (address + count > source.length) return exception(2)
        const out = Buffer.alloc(2 + count * 2)
        out[0] = fc
        out[1] = count * 2
        for (let i = 0; i < count; i++) out.writeUInt16BE(source[address + i] & 0xffff, 2 + i * 2)
        return out
      }
      case 5: {
        this.writes++
        if (address >= this.coils.length) return exception(2)
        this.onCoilWrite(address, pdu.readUInt16BE(3) === 0xff00 ? 1 : 0)
        return pdu.subarray(0, 5)
      }
      case 6: {
        this.writes++
        if (address >= this.holding.length) return exception(2)
        this.holding[address] = pdu.readUInt16BE(3)
        return pdu.subarray(0, 5)
      }
      case 16: {
        this.writes++
        const count = pdu.readUInt16BE(3)
        if (address + count > this.holding.length) return exception(2)
        for (let i = 0; i < count; i++) this.holding[address + i] = pdu.readUInt16BE(6 + i * 2)
        return pdu.subarray(0, 5)
      }
      default:
        return exception(1)
    }
  }

  /** Serves Modbus RTU frames over TCP. */
  listenRtuOverTcp(port: number): Promise<void> {
    return this.listen(port, (socket) => {
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const length = rtuRequestLength(buffer)
          if (length === 0 || buffer.length < length) break
          const frame = buffer.subarray(0, length)
          buffer = buffer.subarray(length)
          const crc = crc16(frame.subarray(0, length - 2))
          if (frame.readUInt16LE(length - 2) !== crc) continue // corrupt frame: no reply
          if (frame[0] !== this.unitId) continue
          const response = Buffer.concat([Buffer.from([this.unitId]), this.handlePdu(frame.subarray(1, length - 2))])
          const out = Buffer.alloc(response.length + 2)
          response.copy(out)
          out.writeUInt16LE(crc16(response), response.length)
          socket.write(out)
        }
      })
    })
  }

  /** Serves Modbus TCP (MBAP header). */
  listenTcp(port: number): Promise<void> {
    return this.listen(port, (socket) => {
      let buffer = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (buffer.length >= 7) {
          const length = buffer.readUInt16BE(4)
          if (buffer.length < 6 + length) break
          const transaction = buffer.readUInt16BE(0)
          const unit = buffer[6]
          const pdu = buffer.subarray(7, 6 + length)
          buffer = buffer.subarray(6 + length)
          const response = this.handlePdu(pdu)
          const header = Buffer.alloc(7)
          header.writeUInt16BE(transaction, 0)
          header.writeUInt16BE(0, 2)
          header.writeUInt16BE(response.length + 1, 4)
          header[6] = unit
          socket.write(Buffer.concat([header, response]))
        }
      })
    })
  }

  private listen(port: number, onSocket: (socket: net.Socket) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
        socket.on('error', () => undefined)
        onSocket(socket)
      })
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => resolve())
      this.servers.push(server)
    })
  }

  /** Drops every connection and stops listening — simulates a pulled cable. */
  async closeServers(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(this.servers.map((s) => new Promise((r) => s.close(() => r(undefined)))))
    this.servers = []
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer)
    await this.closeServers()
  }
}

function rtuRequestLength(buffer: Buffer): number {
  if (buffer.length < 2) return 0
  const fc = buffer[1]
  if (fc >= 1 && fc <= 6) return 8
  if (fc === 15 || fc === 16) return buffer.length < 7 ? 0 : 9 + buffer[6]
  return buffer.length // unknown: consume everything
}

export function crc16(data: Buffer): number {
  let crc = 0xffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1
  }
  return crc
}
