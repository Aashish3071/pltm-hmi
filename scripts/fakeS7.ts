/**
 * A fake Siemens S7 PLC for integration tests. It speaks S7comm over
 * ISO-on-TCP (TPKT + COTP) like an S7-1200, holds a data block laid out as on
 * the pantograph tester (DB6: command bits, REAL speeds, the status STRING at
 * byte 1866) and runs the PLC emulator behind it, so the real S7 driver is
 * exercised over a real socket.
 */
import net from 'net'
import { PlcEmulator } from '../src/main/hardware/PlcEmulator'
import { setS7String } from '../src/main/hardware/s7/S7Client'
import { DEFAULT_S7_MAP } from '../src/main/hardware/config'

const DB_SIZE = 3000

export class FakeS7Plc {
  readonly plc = new PlcEmulator()
  readonly db = Buffer.alloc(DB_SIZE)
  readonly dbNumber = DEFAULT_S7_MAP.dbNumber
  /** Every write request received: [byte offset, length or bit, ...]. */
  readonly writes: { address: number; bit: boolean; data: Buffer }[] = []
  reads = 0
  /** Simulated PLC protection: refuse PUT/GET (access denied). */
  denyAccess = false
  private server: net.Server | null = null
  private sockets = new Set<net.Socket>()
  private timer: NodeJS.Timeout
  private prevBits = { start: false, stop: false, reset: false, home: false }

  constructor() {
    this.timer = setInterval(() => this.scan(25), 25)
    this.publish()
  }

  /** One PLC scan: act on command bits, run the machine, publish the status string. */
  private scan(dtMs: number): void {
    const m = DEFAULT_S7_MAP
    const bit = (b: { byte: number; bit: number }): boolean => (this.db[b.byte] & (1 << b.bit)) !== 0
    const clear = (b: { byte: number; bit: number }): void => {
      this.db[b.byte] &= ~(1 << b.bit)
    }
    this.plc.speeds = {
      up: this.db.readFloatBE(m.writes.upSpeed!),
      down: this.db.readFloatBE(m.writes.downSpeed!),
      jog: this.db.readFloatBE(m.writes.jogSpeed!)
    }
    const distance = this.db.readFloatBE(m.writes.distance!)
    if (distance > 0) this.plc.distanceMm = distance
    const now = {
      start: bit(m.commands.start),
      stop: bit(m.commands.stop),
      reset: bit(m.commands.reset),
      home: bit(m.commands.home)
    }
    if (now.reset) {
      this.plc.reset()
      clear(m.commands.reset)
      now.reset = false
    }
    if (now.stop && !this.prevBits.stop) this.plc.stop()
    if (now.start && !this.prevBits.start && !now.stop) {
      this.plc.start()
      // The PLC program clears the push-button bit once it has acted on it.
      clear(m.commands.start)
      now.start = false
    }
    if (now.home && !this.prevBits.home) this.plc.home()
    this.prevBits = now
    this.plc.tick(dtMs)
    this.publish()
  }

  private publish(): void {
    const s = m().statusString
    setS7String(this.db, s.offset, this.plc.statusString(), s.maxLength)
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server = net.createServer((socket) => this.serve(socket))
      this.server.listen(port, '127.0.0.1', () => resolve((this.server!.address() as net.AddressInfo).port))
    })
  }

  /** Drops every client connection, as a pulled Ethernet cable would. */
  dropClients(): void {
    for (const s of this.sockets) s.destroy()
  }

  close(): Promise<void> {
    clearInterval(this.timer)
    this.dropClients()
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => undefined)
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt16BE(2)
        if (buffer.length < length) return
        const pdu = buffer.subarray(4, length)
        buffer = buffer.subarray(length)
        const reply = this.handle(pdu)
        if (reply) {
          const frame = Buffer.alloc(4 + reply.length)
          frame[0] = 3
          frame.writeUInt16BE(frame.length, 2)
          reply.copy(frame, 4)
          socket.write(frame)
        }
      }
    })
  }

  private handle(pdu: Buffer): Buffer | null {
    if (pdu[1] === 0xe0) {
      // COTP connection request -> confirm (only rack 0 / slot 1 accepted)
      const tsap = pdu.subarray(pdu.length - 2)
      if (tsap[1] !== 0x01) return null
      return Buffer.from([0x11, 0xd0, 0x00, 0x01, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x01, 0x01])
    }
    if (pdu[1] !== 0xf0) return null
    const s7 = pdu.subarray(3)
    const ref = s7.readUInt16BE(4)
    const paramLen = s7.readUInt16BE(6)
    const param = s7.subarray(10, 10 + paramLen)
    const data = s7.subarray(10 + paramLen)
    const fn = param[0]
    if (fn === 0xf0) {
      return ack(ref, Buffer.from([0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0]), Buffer.alloc(0))
    }
    const item = param.subarray(2, 14)
    const transport = item[3]
    const count = item.readUInt16BE(4)
    const db = item.readUInt16BE(6)
    const address = (item[9] << 16) | (item[10] << 8) | item[11]
    if (fn === 0x04) {
      this.reads++
      if (this.denyAccess) return ack(ref, Buffer.from([0x04, 0x01]), Buffer.from([0x03, 0x00, 0x00, 0x00]))
      if (db !== this.dbNumber) return ack(ref, Buffer.from([0x04, 0x01]), Buffer.from([0x0a, 0x00, 0x00, 0x00]))
      const start = address >> 3
      const bytes = this.db.subarray(start, start + count)
      const head = Buffer.from([0xff, 0x04, 0, 0])
      head.writeUInt16BE(bytes.length * 8, 2)
      return ack(ref, Buffer.from([0x04, 0x01]), Buffer.concat([head, bytes]))
    }
    if (fn === 0x05) {
      if (this.denyAccess) return ack(ref, Buffer.from([0x05, 0x01]), Buffer.from([0x03]))
      const payload = data.subarray(4)
      if (transport === 0x01) {
        const byte = address >> 3
        const bit = address & 7
        if (payload[0]) this.db[byte] |= 1 << bit
        else this.db[byte] &= ~(1 << bit)
        this.writes.push({ address, bit: true, data: Buffer.from(payload.subarray(0, 1)) })
      } else {
        const start = address >> 3
        payload.subarray(0, count).copy(this.db, start)
        this.writes.push({ address: start, bit: false, data: Buffer.from(payload.subarray(0, count)) })
      }
      return ack(ref, Buffer.from([0x05, 0x01]), Buffer.from([0xff]))
    }
    return null
  }
}

function m(): typeof DEFAULT_S7_MAP {
  return DEFAULT_S7_MAP
}

function ack(ref: number, param: Buffer, data: Buffer): Buffer {
  const header = Buffer.alloc(12)
  header[0] = 0x32
  header[1] = 0x03
  header.writeUInt16BE(ref, 4)
  header.writeUInt16BE(param.length, 6)
  header.writeUInt16BE(data.length, 8)
  return Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), header, param, data])
}
