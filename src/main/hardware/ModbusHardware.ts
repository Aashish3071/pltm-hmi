import { EventEmitter } from 'events'
import modbusSerial from 'modbus-serial'
import type { ModbusRTU as ModbusClient } from 'modbus-serial/ModbusRTU'
import {
  ErrorCode,
  type CommandSpec,
  type ModbusConnection,
  type ModbusMap,
  type ModelConfig,
  type PlcState,
  type RegisterSpec,
  type SpeedSettings
} from '@shared/types'
import { CommandError } from '../errors'
import { log } from '../logger'
import { delay, disconnectedState, messageOf, type HardwareInterface } from './HardwareInterface'
import { decode, encode, extract, planReads, type ReadBlock } from './modbusCodec'

/** Consecutive failed polls before the link is declared down. */
const MAX_POLL_FAILURES = 3

type ClientCtor = new () => ModbusClient
// modbus-serial is CommonJS; bundlers differ on whether the default import is
// the constructor itself or a wrapper around it.
const ModbusRTU: ClientCtor =
  (modbusSerial as unknown as { default?: ClientCtor }).default ??
  (modbusSerial as unknown as ClientCtor)

/**
 * The machine over Modbus (RTU on serial, RTU over a TCP gateway, or Modbus
 * TCP), for PLCs set up to publish the same six values as the S7 status
 * string in registers. All addresses come from the admin-editable map.
 */
export class ModbusHardware extends EventEmitter implements HardwareInterface {
  private client: ModbusClient | null = null
  private connected = false
  private pollTimer: NodeJS.Timeout | null = null
  private pollFailures = 0
  private queue: Promise<unknown> = Promise.resolve()
  private readonly blocks: ReadBlock[]
  private last: PlcState = disconnectedState()

  constructor(
    private readonly connection: ModbusConnection,
    private readonly map: ModbusMap,
    /** Connection test: read only, never writes. */
    private readonly probeOnly = false
  ) {
    super()
    this.blocks = planReads(this.pollSpecs())
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const client = new ModbusRTU()
    const c = this.connection
    // Port failures (USB adapter pulled, gateway reset) arrive as 'error'
    // events; unhandled, Node treats them as fatal.
    const onPortLost = (reason: string): void => {
      if (this.client === client && this.connected) this.dropLink(reason)
    }
    ;(client as unknown as EventEmitter).on('error', (error: unknown) =>
      onPortLost(`port error: ${messageOf(error)}`)
    )
    ;(client as unknown as EventEmitter).on('close', () => onPortLost('port closed'))
    try {
      await withTimeout(this.openTransport(client), Math.max(3000, c.timeoutMs * 3), 'Connection timed out')
      client.setID(c.unitId)
      client.setTimeout(c.timeoutMs)
      this.client = client
      await this.pollOnce()
    } catch (error) {
      this.client = null
      closeQuietly(client)
      throw new CommandError(ErrorCode.CONNECTION_FAILED, `${describe(c)}: ${messageOf(error)}`)
    }
    this.connected = true
    this.pollFailures = 0
    if (this.probeOnly) return
    log.info(`Modbus connected (${describe(c)})`)
    this.emit('connection', true)
    this.schedulePoll()
  }

  private async openTransport(client: ModbusClient): Promise<void> {
    const c = this.connection
    if (c.transport === 'rtu-serial') {
      await client.connectRTUBuffered(c.serialPath, {
        baudRate: c.baudRate,
        parity: c.parity,
        dataBits: c.dataBits,
        stopBits: c.stopBits
      })
    } else if (c.transport === 'rtu-tcp') {
      // Raw RTU frames (with CRC) over a socket, as a transparent
      // serial-to-Ethernet gateway expects. modbus-serial's
      // connectTcpRTUBuffered sends MBAP framing despite its name.
      await client.connectTelnet(c.host, { port: c.port })
    } else {
      await client.connectTCP(c.host, { port: c.port })
    }
  }

  async disconnect(): Promise<void> {
    this.dropLink('disconnect requested')
  }

  private dropLink(reason: string): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    const was = this.connected
    this.connected = false
    if (this.client) closeQuietly(this.client)
    this.client = null
    this.last = disconnectedState(this.last)
    if (was && !this.probeOnly) {
      log.warn(`Modbus link down: ${reason}`)
      this.emit('connection', false)
      this.emit('state', this.last)
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async start(model: ModelConfig): Promise<void> {
    const { writes, commands } = this.map
    if (writes.distance) await this.writeValue(writes.distance, model.distanceMm)
    if (commands.resume) await this.command(commands.resume)
    await this.command(commands.start)
  }

  async stop(): Promise<void> {
    await this.command(this.map.commands.stop)
  }

  async reset(): Promise<void> {
    await this.command(this.map.commands.reset)
  }

  async home(): Promise<void> {
    await this.command(this.map.commands.home)
  }

  async writeSpeeds(speeds: SpeedSettings): Promise<void> {
    if (!this.client) return
    const { upSpeed, downSpeed, jogSpeed } = this.map.writes
    if (upSpeed) await this.writeValue(upSpeed, speeds.up)
    if (downSpeed) await this.writeValue(downSpeed, speeds.down)
    if (jogSpeed) await this.writeValue(jogSpeed, speeds.jog)
  }

  getState(): PlcState {
    return this.last
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private pollSpecs(): RegisterSpec[] {
    const { load, position, status, upTime, downTime, mode } = this.map
    return [load, position, status, upTime, downTime, mode].filter((s): s is RegisterSpec => !!s)
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollOnce()
        this.pollFailures = 0
      } catch (error) {
        if (!this.connected) return
        this.pollFailures++
        log.warn(`Poll failed (${this.pollFailures}/${MAX_POLL_FAILURES}): ${messageOf(error)}`)
        if (this.pollFailures >= MAX_POLL_FAILURES) {
          this.dropLink(messageOf(error))
          return
        }
      }
      if (this.connected) this.schedulePoll()
    }, this.connection.pollIntervalMs)
  }

  private async pollOnce(): Promise<void> {
    const results = await this.enqueue(async () => {
      const out: number[][] = []
      for (const block of this.blocks) out.push(await this.readBlock(block))
      return out
    })
    const value = (spec: RegisterSpec | null): number | null => {
      if (!spec) return null
      const words = extract(spec, this.blocks, results)
      if (!words) throw new Error(`register ${spec.area}:${spec.address} not in poll plan`)
      return decode(spec, words)
    }
    const mode = value(this.map.mode)
    this.last = {
      connected: true,
      timestampMs: Date.now(),
      loadN: Math.round((value(this.map.load) ?? 0) * 100) / 100,
      positionMm: Math.trunc(value(this.map.position) ?? 0),
      code: Math.round(value(this.map.status) ?? 0),
      upTimeSec: value(this.map.upTime) ?? 0,
      downTimeSec: value(this.map.downTime) ?? 0,
      mode: mode === null ? null : Math.round(mode) === 1 ? 'MANUAL' : 'AUTO'
    }
    if (this.connected && !this.probeOnly) this.emit('state', this.last)
  }

  private async readBlock(block: ReadBlock): Promise<number[]> {
    const client = this.requireClient()
    switch (block.area) {
      case 'holding':
        return (await client.readHoldingRegisters(block.start, block.count)).data
      case 'input':
        return (await client.readInputRegisters(block.start, block.count)).data
      case 'coil':
        return (await client.readCoils(block.start, block.count)).data.slice(0, block.count).map(Number)
      case 'discrete':
        return (await client.readDiscreteInputs(block.start, block.count)).data
          .slice(0, block.count)
          .map(Number)
    }
  }

  // -------------------------------------------------------------------------
  // Low-level writes
  // -------------------------------------------------------------------------

  private requireClient(): ModbusClient {
    if (!this.client) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
    return this.client
  }

  /** Serialises all bus traffic — RTU is half-duplex, one request at a time. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      try {
        return await task()
      } catch (error) {
        if (error instanceof CommandError) throw error
        throw new CommandError(ErrorCode.CONNECTION_FAILED, `Machine did not respond (${messageOf(error)})`)
      }
    }
    const next = this.queue.then(guarded, guarded)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async command(spec: CommandSpec): Promise<void> {
    if (this.probeOnly) return
    await this.enqueue(() => this.writeCommandValue(spec, spec.value ?? 1))
    if (spec.pulseMs && spec.pulseMs > 0) {
      await delay(spec.pulseMs)
      await this.enqueue(() => this.writeCommandValue(spec, 0))
    }
  }

  private async writeCommandValue(spec: CommandSpec, value: number): Promise<void> {
    const client = this.requireClient()
    if (spec.area === 'coil') await client.writeCoil(spec.address, value !== 0)
    else await client.writeRegister(spec.address, value & 0xffff)
  }

  private async writeValue(spec: RegisterSpec, value: number): Promise<void> {
    if (this.probeOnly) return
    const words = encode(spec, value)
    await this.enqueue(async () => {
      const client = this.requireClient()
      if (words.length === 1) await client.writeRegister(spec.address, words[0])
      else await client.writeRegisters(spec.address, words)
    })
  }
}

function describe(c: ModbusConnection): string {
  if (c.transport === 'rtu-serial') {
    return `RTU ${c.serialPath} ${c.baudRate} ${c.dataBits}${c.parity[0].toUpperCase()}${c.stopBits}, slave ${c.unitId}`
  }
  const kind = c.transport === 'rtu-tcp' ? 'RTU over TCP' : 'Modbus TCP'
  return `${kind} ${c.host}:${c.port}, slave ${c.unitId}`
}

function closeQuietly(client: ModbusClient): void {
  try {
    client.close(() => undefined)
  } catch {
    // already closed
  }
  // close() only ends the socket gracefully; a connect still in progress (e.g.
  // to an absent gateway) must be destroyed or it lingers until the OS gives up.
  const port = (client as unknown as { _port?: { _client?: { destroy?: () => void } } })._port
  try {
    port?._client?.destroy?.()
  } catch {
    // not a socket transport
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
