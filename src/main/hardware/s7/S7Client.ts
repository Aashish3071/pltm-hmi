import { Socket } from 'net'

/**
 * Minimal Siemens S7 client (S7comm over ISO-on-TCP, RFC 1006), covering what
 * the app needs: read bytes from a data block,
 * write bytes, write single bits. Works with S7-300/400/1200/1500; on a
 * 1200/1500 the data block must not use optimized access and PUT/GET must be
 * allowed in the PLC's protection settings.
 */

const AREA_DB = 0x84
const TS_BYTE = 0x02
const TS_BIT = 0x01
/** Data transport sizes in a write request. */
const DATA_TS_BIT = 0x03
const DATA_TS_BYTE = 0x04

export class S7Error extends Error {}

export interface S7ClientOptions {
  host: string
  port?: number
  rack: number
  slot: number
  timeoutMs?: number
}

export class S7Client {
  private socket: Socket | null = null
  private buffer = Buffer.alloc(0)
  private waiter: { resolve: (pdu: Buffer) => void; reject: (e: Error) => void } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private pduRef = 1
  private pduSize = 240
  private closedHandlers: ((reason: string) => void)[] = []

  constructor(private readonly options: S7ClientOptions) {}

  get connected(): boolean {
    return this.socket !== null
  }

  /** Called once when an open connection is lost (not on close()). */
  onClosed(handler: (reason: string) => void): void {
    this.closedHandlers.push(handler)
  }

  get maxPduSize(): number {
    return this.pduSize
  }

  async connect(): Promise<void> {
    const { host, port = 102, timeoutMs = 2000 } = this.options
    const socket = new Socket()
    socket.setNoDelay(true)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new S7Error(`Connection to ${host}:${port} timed out`))
      }, Math.max(timeoutMs, 3000))
      socket.once('error', (error) => {
        clearTimeout(timer)
        socket.destroy()
        reject(new S7Error(`${host}:${port}: ${error.message}`))
      })
      socket.connect(port, host, () => {
        clearTimeout(timer)
        socket.removeAllListeners('error')
        resolve()
      })
    })
    this.socket = socket
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => this.lost(error.message))
    socket.on('close', () => this.lost('connection closed'))
    try {
      await this.cotpConnect()
      await this.setupCommunication()
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    const socket = this.socket
    this.socket = null
    this.buffer = Buffer.alloc(0)
    if (socket) {
      socket.removeAllListeners()
      socket.on('error', () => undefined)
      socket.destroy()
    }
    this.failWaiter(new S7Error('Connection closed'))
  }

  private lost(reason: string): void {
    if (!this.socket) return
    this.close()
    for (const handler of this.closedHandlers) handler(reason)
  }

  // -------------------------------------------------------------------------
  // Public operations
  // -------------------------------------------------------------------------

  /** Reads `length` bytes from DB`db` starting at byte `start`. */
  dbRead(db: number, start: number, length: number): Promise<Buffer> {
    return this.serial(async () => {
      const chunk = this.pduSize - 18
      const out: Buffer[] = []
      for (let offset = 0; offset < length; offset += chunk) {
        const n = Math.min(chunk, length - offset)
        out.push(await this.readOnce(db, start + offset, n))
      }
      return Buffer.concat(out)
    })
  }

  dbWrite(db: number, start: number, data: Buffer): Promise<void> {
    return this.serial(async () => {
      const chunk = this.pduSize - 28
      for (let offset = 0; offset < data.length; offset += chunk) {
        await this.writeOnce(db, start + offset, data.subarray(offset, offset + chunk), false)
      }
    })
  }

  /** Writes a single bit (DBX byte.bit) without touching the rest of the byte. */
  dbWriteBit(db: number, byte: number, bit: number, value: boolean): Promise<void> {
    return this.serial(() => this.writeOnce(db, byte * 8 + bit, Buffer.from([value ? 1 : 0]), true))
  }

  // -------------------------------------------------------------------------
  // Protocol
  // -------------------------------------------------------------------------

  private async cotpConnect(): Promise<void> {
    const { rack, slot } = this.options
    const remoteTsap = 0x0100 + rack * 0x20 + slot
    const cotp = Buffer.from([
      0x11, 0xe0, 0x00, 0x00, 0x00, 0x01, 0x00,
      0xc0, 0x01, 0x0a,
      0xc1, 0x02, 0x01, 0x00,
      0xc2, 0x02, (remoteTsap >> 8) & 0xff, remoteTsap & 0xff
    ])
    const reply = await this.transact(cotp)
    if (reply.length < 2 || reply[1] !== 0xd0) {
      throw new S7Error('PLC refused the connection (check rack/slot)')
    }
  }

  private async setupCommunication(): Promise<void> {
    const param = Buffer.from([0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0xc0])
    const { param: reply } = await this.s7Request(param, Buffer.alloc(0))
    if (reply.length >= 8) this.pduSize = reply.readUInt16BE(6)
  }

  private async readOnce(db: number, start: number, length: number): Promise<Buffer> {
    const param = Buffer.concat([Buffer.from([0x04, 0x01]), item(TS_BYTE, length, db, start * 8)])
    const { data } = await this.s7Request(param, Buffer.alloc(0))
    if (data.length < 4) throw new S7Error('Short read response')
    checkReturnCode(data[0], `read DB${db}.DBB${start}`)
    const bits = data.readUInt16BE(2)
    const bytes = data[1] === DATA_TS_BYTE || data[1] === 0x05 ? bits / 8 : bits
    return Buffer.from(data.subarray(4, 4 + bytes))
  }

  /** `address` is a bit address (byte × 8 + bit) for a bit write, a byte offset otherwise. */
  private async writeOnce(db: number, address: number, payload: Buffer, bit: boolean): Promise<void> {
    const count = bit ? 1 : payload.length
    const bitAddress = bit ? address : address * 8
    const param = Buffer.concat([Buffer.from([0x05, 0x01]), item(bit ? TS_BIT : TS_BYTE, count, db, bitAddress)])
    const header = Buffer.alloc(4)
    header[0] = 0x00
    header[1] = bit ? DATA_TS_BIT : DATA_TS_BYTE
    header.writeUInt16BE(bit ? 1 : payload.length * 8, 2)
    const { data } = await this.s7Request(param, Buffer.concat([header, payload]))
    if (data.length < 1) throw new S7Error('Short write response')
    checkReturnCode(data[0], `write DB${db}`)
  }

  /** Sends a job (ROSCTR 1) and returns the ack-data's parameter and data parts. */
  private async s7Request(param: Buffer, data: Buffer): Promise<{ param: Buffer; data: Buffer }> {
    const ref = this.pduRef
    this.pduRef = (this.pduRef + 1) & 0xffff || 1
    const header = Buffer.alloc(10)
    header[0] = 0x32
    header[1] = 0x01
    header.writeUInt16BE(ref, 4)
    header.writeUInt16BE(param.length, 6)
    header.writeUInt16BE(data.length, 8)
    const reply = await this.transact(Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), header, param, data]))
    // reply = COTP DT (3 bytes) + S7 ack-data header (12 bytes) + param + data
    const s7 = reply.subarray(3)
    if (s7.length < 12 || s7[0] !== 0x32) throw new S7Error('Invalid S7 response')
    if (s7[1] !== 0x03 && s7[1] !== 0x02) throw new S7Error(`Unexpected S7 PDU type ${s7[1]}`)
    const errorClass = s7[10]
    const errorCode = s7[11]
    if (errorClass !== 0 || errorCode !== 0) {
      throw new S7Error(`PLC rejected the request (error ${errorClass}/${errorCode}${hintFor(errorClass, errorCode)})`)
    }
    const paramLen = s7.readUInt16BE(6)
    const dataLen = s7.readUInt16BE(8)
    return {
      param: s7.subarray(12, 12 + paramLen),
      data: s7.subarray(12 + paramLen, 12 + paramLen + dataLen)
    }
  }

  /** Writes a TPKT frame and waits for the next one. */
  private transact(payload: Buffer): Promise<Buffer> {
    const socket = this.socket
    if (!socket) return Promise.reject(new S7Error('Not connected'))
    const frame = Buffer.alloc(4 + payload.length)
    frame[0] = 0x03
    frame.writeUInt16BE(frame.length, 2)
    payload.copy(frame, 4)
    const timeoutMs = this.options.timeoutMs ?? 2000
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null
        reject(new S7Error('PLC did not answer in time'))
        this.lost('response timeout')
      }, timeoutMs)
      this.waiter = {
        resolve: (pdu) => {
          clearTimeout(timer)
          resolve(pdu)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      }
      socket.write(frame)
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt16BE(2)
      if (this.buffer[0] !== 0x03 || length < 7) {
        this.lost('corrupt frame from PLC')
        return
      }
      if (this.buffer.length < length) return
      const pdu = Buffer.from(this.buffer.subarray(4, length))
      this.buffer = this.buffer.subarray(length)
      const waiter = this.waiter
      this.waiter = null
      waiter?.resolve(pdu)
    }
  }

  private failWaiter(error: Error): void {
    const waiter = this.waiter
    this.waiter = null
    waiter?.reject(error)
  }

  /** One request at a time on the connection. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => undefined)
    return next
  }
}

function item(transportSize: number, count: number, db: number, bitAddress: number): Buffer {
  const b = Buffer.alloc(12)
  b[0] = 0x12
  b[1] = 0x0a
  b[2] = 0x10
  b[3] = transportSize
  b.writeUInt16BE(count, 4)
  b.writeUInt16BE(db, 6)
  b[8] = AREA_DB
  b[9] = (bitAddress >> 16) & 0xff
  b[10] = (bitAddress >> 8) & 0xff
  b[11] = bitAddress & 0xff
  return b
}

function checkReturnCode(code: number, what: string): void {
  if (code === 0xff) return
  const reasons: Record<number, string> = {
    0x03: 'access denied — enable PUT/GET in the PLC and turn off optimized block access',
    0x05: 'address out of range',
    0x06: 'data type not supported',
    0x07: 'data type inconsistent',
    0x0a: 'data block does not exist'
  }
  throw new S7Error(`${what}: ${reasons[code] ?? `item error 0x${code.toString(16)}`}`)
}

function hintFor(errorClass: number, errorCode: number): string {
  if (errorClass === 0x81 && errorCode === 0x04) return ' — function not allowed; enable PUT/GET in the PLC'
  if (errorClass === 0x85) return ' — request too large'
  return ''
}

// ---------------------------------------------------------------------------
// S7 data helpers
// ---------------------------------------------------------------------------

/** S7 STRING: byte 0 = max length, byte 1 = actual length, then the characters. */
export function getS7String(buffer: Buffer, offset = 0): string {
  const max = buffer[offset]
  const length = buffer[offset + 1]
  if (length > max || max > 254) throw new S7Error('Invalid STRING format')
  return buffer.subarray(offset + 2, offset + 2 + length).toString('latin1')
}

export function setS7String(buffer: Buffer, offset: number, value: string, maxLength: number): void {
  const text = value.slice(0, maxLength)
  buffer[offset] = maxLength
  buffer[offset + 1] = text.length
  buffer.write(text, offset + 2, 'latin1')
}

export function realBytes(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeFloatBE(value, 0)
  return b
}
