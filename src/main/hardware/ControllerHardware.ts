import { EventEmitter } from 'events'
import modbusSerial from 'modbus-serial'
import type { ModbusRTU as ModbusClient } from 'modbus-serial/ModbusRTU'
import {
  ErrorCode,
  StatusCode,
  type ModbusConnection,
  type ModelConfig,
  type PlcState,
  type SpeedSettings
} from '@shared/types'
import { CommandError } from '../errors'
import { log } from '../logger'
import { delay, disconnectedState, messageOf, type HardwareInterface } from './HardwareInterface'

type ClientCtor = new () => ModbusClient
const ModbusRTU: ClientCtor =
  (modbusSerial as unknown as { default?: ClientCtor }).default ?? (modbusSerial as unknown as ClientCtor)

/**
 * Register layout of the PantoCheck controller firmware
 * (firmware/pltm-controller/Registers.h). Addresses are 0-based.
 */
const COIL = { START: 0, STOP: 1, RESET: 2, HOME: 3 }
const DISCRETE = { HOMED: 0, ESTOP: 1, OVERLOAD: 2, UPPER_LIMIT: 3, LOWER_LIMIT: 4, COUNT: 5 }
const HOLDING = { UP_SPEED: 0, DOWN_SPEED: 1, JOG_SPEED: 2, TRAVEL: 3, OVERLOAD_LIMIT: 4, TRAVEL_LIMIT: 5, HEARTBEAT: 6 }
const INPUT = { COUNT: 6 }

/** Controller status register → the app's status codes. */
const STATUS_MAP: Record<number, number> = {
  0: StatusCode.HOMING_NOT_DONE,
  1: StatusCode.READY,
  2: StatusCode.PANTO_RAISING,
  3: StatusCode.PANTO_RAISING_COMPLETED,
  4: StatusCode.PANTO_RETRIEVING,
  5: StatusCode.HALT,
  10: StatusCode.EMERGENCY_PRESSED,
  11: StatusCode.SERVO_ERROR,
  12: StatusCode.OVERLOAD
}

const PULSE_MS = 200
const HEARTBEAT_MS = 500
const MAX_POLL_FAILURES = 3
/** The controller goes straight from lowering to READY; the app shows CYCLE COMPLETED this long. */
const COMPLETE_HOLD_MS = 1500

export interface ControllerLimits {
  /** Overload trip, N. */
  loadCapacityN: number
  /** Soft travel limit, mm. */
  heightCapacityMm: number
}

/**
 * The PantoCheck controller (Arduino) over Modbus RTU. The controller runs the
 * motion and its safety functions; this driver translates its registers to the
 * app's status codes, keeps the cycle timers, sends set-points and feeds the
 * controller's communication watchdog (motion stops if the heartbeat stalls).
 */
export class ControllerHardware extends EventEmitter implements HardwareInterface {
  private client: ModbusClient | null = null
  private connected = false
  private pollTimer: NodeJS.Timeout | null = null
  private pollFailures = 0
  private queue: Promise<unknown> = Promise.resolve()
  private last: PlcState = disconnectedState()
  private heartbeat = 0
  private lastHeartbeatAt = 0
  private lastPollAt = 0
  private upMs = 0
  private downMs = 0
  private rawCode: number = StatusCode.HOMING_NOT_DONE
  private completeUntil = 0

  constructor(
    private readonly connection: ModbusConnection,
    private readonly limits: () => ControllerLimits,
    private readonly probeOnly = false
  ) {
    super()
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const client = new ModbusRTU()
    const c = this.connection
    const lost = (reason: string): void => {
      if (this.client === client && this.connected) this.dropLink(reason)
    }
    ;(client as unknown as EventEmitter).on('error', (error: unknown) => lost(`port error: ${messageOf(error)}`))
    ;(client as unknown as EventEmitter).on('close', () => lost('port closed'))
    try {
      await withTimeout(this.open(client), Math.max(3000, c.timeoutMs * 3), 'Connection timed out')
      client.setID(c.unitId)
      client.setTimeout(c.timeoutMs)
      this.client = client
      await this.pollOnce()
    } catch (error) {
      this.client = null
      closeQuietly(client)
      throw new CommandError(ErrorCode.CONNECTION_FAILED, `Controller ${describe(c)}: ${messageOf(error)}`)
    }
    this.connected = true
    this.pollFailures = 0
    if (this.probeOnly) return
    log.info(`Controller connected (${describe(c)})`)
    this.emit('connection', true)
    await this.writeLimits().catch((error) => log.warn('Could not write limits to the controller', messageOf(error)))
    this.schedulePoll()
  }

  private async open(client: ModbusClient): Promise<void> {
    const c = this.connection
    if (c.transport === 'rtu-serial') {
      await client.connectRTUBuffered(c.serialPath, {
        baudRate: c.baudRate,
        parity: c.parity,
        dataBits: c.dataBits,
        stopBits: c.stopBits
      })
    } else if (c.transport === 'rtu-tcp') {
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
      log.warn(`Controller link down: ${reason}`)
      this.emit('connection', false)
      this.emit('state', this.last)
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async start(model: ModelConfig): Promise<void> {
    const resuming = this.rawCode === StatusCode.HALT
    if (!resuming) {
      await this.writeRegister(HOLDING.TRAVEL, clamp16(model.distanceMm))
      this.upMs = 0
      this.downMs = 0
    }
    this.completeUntil = 0
    await this.pulse(COIL.START)
  }

  async stop(): Promise<void> {
    await this.pulse(COIL.STOP)
  }

  async reset(): Promise<void> {
    this.completeUntil = 0
    this.upMs = 0
    this.downMs = 0
    await this.pulse(COIL.RESET)
  }

  async home(): Promise<void> {
    await this.pulse(COIL.HOME)
  }

  async writeSpeeds(speeds: SpeedSettings): Promise<void> {
    if (!this.client || this.probeOnly) return
    await this.enqueue(async () => {
      await this.requireClient().writeRegisters(HOLDING.UP_SPEED, [
        clamp16(speeds.up * 10),
        clamp16(speeds.down * 10),
        clamp16(speeds.jog * 10)
      ])
    })
  }

  getState(): PlcState {
    return this.last
  }

  async refreshLimits(): Promise<void> {
    if (this.client && !this.probeOnly) await this.writeLimits()
  }

  private async writeLimits(): Promise<void> {
    const { loadCapacityN, heightCapacityMm } = this.limits()
    await this.writeRegister(HOLDING.OVERLOAD_LIMIT, clamp16(loadCapacityN * 10))
    await this.writeRegister(HOLDING.TRAVEL_LIMIT, clamp16(heightCapacityMm))
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private schedulePoll(): void {
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollOnce()
        await this.feedWatchdog()
        this.pollFailures = 0
      } catch (error) {
        if (!this.connected) return
        this.pollFailures++
        log.warn(`Controller poll failed (${this.pollFailures}/${MAX_POLL_FAILURES}): ${messageOf(error)}`)
        if (this.pollFailures >= MAX_POLL_FAILURES) {
          this.dropLink(messageOf(error))
          return
        }
      }
      if (this.connected) this.schedulePoll()
    }, this.connection.pollIntervalMs)
  }

  private async pollOnce(): Promise<void> {
    const [inputs, discrete] = await this.enqueue(async () => {
      const client = this.requireClient()
      const i = (await client.readInputRegisters(0, INPUT.COUNT)).data
      const d = (await client.readDiscreteInputs(0, DISCRETE.COUNT)).data.map(Boolean)
      return [i, d] as const
    })
    const int32 = (hi: number, lo: number): number => ((hi & 0xffff) << 16) | (lo & 0xffff)
    const loadN = int32(inputs[0], inputs[1]) / 100
    const positionMm = int32(inputs[2], inputs[3]) / 100
    const now = Date.now()
    const dt = this.lastPollAt ? Math.min(now - this.lastPollAt, 1000) : 0
    this.lastPollAt = now

    // Hard-wired safety inputs outrank the status register.
    let code = STATUS_MAP[inputs[4]] ?? StatusCode.HOMING_NOT_DONE
    if (discrete[DISCRETE.ESTOP]) code = StatusCode.EMERGENCY_PRESSED
    else if (discrete[DISCRETE.OVERLOAD]) code = StatusCode.OVERLOAD
    else if (discrete[DISCRETE.UPPER_LIMIT] || discrete[DISCRETE.LOWER_LIMIT]) code = StatusCode.OVER_TRAVEL

    if (this.rawCode === StatusCode.PANTO_RETRIEVING && code === StatusCode.READY) this.completeUntil = now + COMPLETE_HOLD_MS
    if (code !== StatusCode.READY) this.completeUntil = 0
    this.rawCode = code
    if (code === StatusCode.PANTO_RAISING) this.upMs += dt
    if (code === StatusCode.PANTO_RETRIEVING) this.downMs += dt

    this.last = {
      connected: true,
      timestampMs: now,
      loadN: Math.round(loadN * 100) / 100,
      positionMm: Math.round(positionMm),
      code: now < this.completeUntil ? StatusCode.CYCLE_COMPLETED : code,
      upTimeSec: Math.floor(this.upMs / 1000),
      downTimeSec: Math.floor(this.downMs / 1000),
      mode: inputs[5] === 1 ? 'MANUAL' : 'AUTO'
    }
    if (this.connected && !this.probeOnly) this.emit('state', this.last)
  }

  /** The controller halts app-started motion if this counter stops changing for 2 s. */
  private async feedWatchdog(): Promise<void> {
    if (this.probeOnly || !this.connected || Date.now() - this.lastHeartbeatAt < HEARTBEAT_MS) return
    this.heartbeat = (this.heartbeat + 1) & 0xffff
    await this.writeRegister(HOLDING.HEARTBEAT, this.heartbeat)
    this.lastHeartbeatAt = Date.now()
  }

  // -------------------------------------------------------------------------
  // Low level
  // -------------------------------------------------------------------------

  private requireClient(): ModbusClient {
    if (!this.client) {
      const cable = this.connection.transport === 'rtu-serial' ? 'the USB-RS485 cable' : 'the Ethernet cable'
      throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED, `Controller disconnected. Check the machine power and ${cable}.`)
    }
    return this.client
  }

  /** RTU is half-duplex: one request at a time. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      try {
        return await task()
      } catch (error) {
        if (error instanceof CommandError) throw error
        throw new CommandError(ErrorCode.CONNECTION_FAILED, `Controller did not respond (${messageOf(error)})`)
      }
    }
    const next = this.queue.then(guarded, guarded)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async pulse(coil: number): Promise<void> {
    if (this.probeOnly) return
    await this.enqueue(() => this.requireClient().writeCoil(coil, true))
    await delay(PULSE_MS)
    await this.enqueue(() => this.requireClient().writeCoil(coil, false))
  }

  private async writeRegister(address: number, value: number): Promise<void> {
    if (this.probeOnly) return
    await this.enqueue(() => this.requireClient().writeRegister(address, value & 0xffff))
  }
}

function clamp16(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 0xffff)
}

function describe(c: ModbusConnection): string {
  if (c.transport === 'rtu-serial') return `${c.serialPath} ${c.baudRate} baud, slave ${c.unitId}`
  return `${c.host}:${c.port}, slave ${c.unitId}`
}

function closeQuietly(client: ModbusClient): void {
  try {
    client.close(() => undefined)
  } catch {
    // already closed
  }
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
