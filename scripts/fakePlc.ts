/**
 * A fake pantograph-tester PLC for Modbus integration tests. It speaks Modbus
 * RTU framing (with CRC-16) over a TCP socket or a serial stream, or Modbus
 * TCP (MBAP), and publishes the PLC emulator's six values in the registers of
 * DEFAULT_MODBUS_MAP.
 */
import net from 'net'
import { PlcEmulator } from '../src/main/hardware/PlcEmulator'

export class FakePlc {
  readonly plc = new PlcEmulator()
  coils = new Array<number>(32).fill(0)
  discrete = new Array<number>(16).fill(0)
  holding = new Array<number>(40).fill(0)
  input = new Array<number>(16).fill(0)
  writes = 0
  requests = 0
  private timer: NodeJS.Timeout
  private servers: net.Server[] = []
  private sockets = new Set<net.Socket>()

  constructor(private readonly unitId = 1) {
    this.timer = setInterval(() => this.tick(25), 25)
    this.sync()
  }

  private float(address: number): number {
    const b = Buffer.alloc(4)
    b.writeUInt16BE(this.holding[address], 0)
    b.writeUInt16BE(this.holding[address + 1], 2)
    return b.readFloatBE(0)
  }

  private onCoilWrite(address: number, value: number): void {
    this.coils[address] = value
    if (address === 3 && value) {
      if (!this.coils[10]) this.plc.start()
      this.coils[3] = 0
    }
    if (address === 10 && value) this.plc.stop()
    if (address === 6 && value) {
      this.plc.reset()
      this.coils[6] = 0
    }
    if (address === 8 && value) this.plc.home()
  }

  private tick(dtMs: number): void {
    this.plc.speeds = { up: this.float(20) || 50, down: this.float(22) || 50, jog: this.float(24) || 50 }
    const distance = this.float(26)
    if (distance > 0) this.plc.distanceMm = distance
    this.plc.tick(dtMs)
    this.sync()
  }

  private sync(): void {
    const int32 = (address: number, value: number): void => {
      const b = Buffer.alloc(4)
      b.writeInt32BE(Math.round(value), 0)
      this.holding[address] = b.readUInt16BE(0)
      this.holding[address + 1] = b.readUInt16BE(2)
    }
    int32(0, this.plc.loadN * 100)
    int32(2, this.plc.positionMm)
    this.holding[4] = this.plc.code
    this.holding[5] = this.plc.upTimeSec
    this.holding[6] = this.plc.downTimeSec
    this.holding[7] = this.plc.mode === 'MANUAL' ? 1 : 2
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
    return this.listen(port, (socket) => this.serveRtu(socket))
  }

  /**
   * Answers Modbus RTU frames on any byte stream: a TCP socket (transparent
   * gateway) or a serial port (RS-485 adapter).
   */
  serveRtu(stream: {
    on(event: 'data', listener: (chunk: Buffer) => void): unknown
    write(data: Buffer): unknown
  }): void {
    let buffer = Buffer.alloc(0)
    stream.on('data', (chunk) => {
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
        stream.write(out)
      }
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

  /** Hard-resets every connection (TCP RST) — a gateway reboot or yanked cable. */
  resetConnections(): void {
    for (const socket of this.sockets) socket.resetAndDestroy()
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
