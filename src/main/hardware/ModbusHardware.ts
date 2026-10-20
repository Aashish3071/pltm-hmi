import { EventEmitter } from 'events'
import modbusSerial from 'modbus-serial'
import type { ModbusRTU as ModbusClient } from 'modbus-serial/ModbusRTU'
import {
  ErrorCode,
  FAULT_STATUSES,
  HardwareStatus,
  type CommandSpec,
  type HardwareSnapshot,
  type JogDirection,
  type MachineMode,
  type ModbusConnection,
  type ModelConfig,
  type RegisterMap,
  type RegisterSpec,
  type RunPhase,
  type SpeedSettings
} from '@shared/types'
import { CommandError } from '../errors'
import { log } from '../logger'
import type { HardwareInterface } from './HardwareInterface'
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
 * Talks to the PLTM control box over Modbus (RTU on serial, RTU over a TCP
 * gateway, or Modbus TCP). All addresses come from the admin-editable register
 * map, so commissioning a machine is configuration, not code.
 *
 * The PLC owns the motion state machine; this driver polls its status and
 * telemetry, translates them into the app's status/phase model, and keeps the
 * app-side bookkeeping (cycle timers, run start, reset-before-run) that the
 * PLC does not report.
 */
export class ModbusHardware extends EventEmitter implements HardwareInterface {
  private client: ModbusClient | null = null
  private connected = false
  private pollTimer: NodeJS.Timeout | null = null
  private pollFailures = 0
  private queue: Promise<unknown> = Promise.resolve()
  private blocks: ReadBlock[] = []

  private status: HardwareStatus = HardwareStatus.DISCONNECTED
  private plcStatus: HardwareStatus = HardwareStatus.DISCONNECTED
  private mode: MachineMode = 'AUTO'
  private homed = false
  private resetSinceLastRun = true
  private loadN = 0
  private heightMm = 0
  private model: ModelConfig | null = null
  private runStartMs = 0
  private upCycleSec = 0
  private downCycleSec = 0
  private phaseStartMs = 0
  /** Software overload trip: latched until RESET, independent of the PLC. */
  private overloadLatched = false

  constructor(
    private readonly connection: ModbusConnection,
    private readonly map: RegisterMap,
    private speeds: SpeedSettings,
    private loadCapacityN: number,
    /** Probe mode (connection test): read-only, never writes to the PLC. */
    private readonly probeOnly = false
  ) {
    super()
    this.blocks = planReads(this.pollSpecs())
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return
    const client = new ModbusRTU()
    const c = this.connection
    // The client re-emits port failures (USB adapter pulled, gateway socket
    // reset) as 'error' events; unhandled, Node treats them as fatal. Treat
    // both error and close as an immediate link loss.
    const onPortLost = (reason: string): void => {
      if (this.client === client && this.connected) this.dropLink(reason)
    }
    ;(client as unknown as EventEmitter).on('error', (error: unknown) =>
      onPortLost(`port error: ${messageOf(error)}`)
    )
    ;(client as unknown as EventEmitter).on('close', () => onPortLost('port closed'))
    try {
      await withTimeout(this.openTransport(client), connectTimeoutMs(c), 'Connection timed out')
      client.setID(c.unitId)
      client.setTimeout(c.timeoutMs)
      this.client = client
      // Prove the slave answers before declaring the link up.
      await this.pollOnce()
    } catch (error) {
      this.client = null
      closeQuietly(client)
      throw new CommandError(ErrorCode.CONNECTION_FAILED, `${describe(c)}: ${messageOf(error)}`)
    }

    this.connected = true
    this.pollFailures = 0
    if (this.probeOnly) {
      this.status = this.plcStatus
      return
    }
    this.emit('connection', { connected: true })
    this.applyStatus(this.plcStatus)
    await this.setSpeeds(this.speeds).catch((error) =>
      log.warn('Could not write speeds after connect', messageOf(error))
    )
    this.schedulePoll()
    log.info(`Modbus connected (${describe(c)})`)
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
      // serial-to-Ethernet gateway expects. Note: modbus-serial's
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
    const wasConnected = this.connected
    this.connected = false
    if (this.client) closeQuietly(this.client)
    this.client = null
    if (wasConnected) {
      log.warn(`Modbus link down: ${reason}`)
      this.emit('connection', { connected: false })
    }
    this.applyStatus(HardwareStatus.DISCONNECTED)
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async start(model: ModelConfig): Promise<void> {
    const resuming = this.status === HardwareStatus.HALT
    if (!resuming) {
      if (this.map.writes.travelDistance) {
        await this.writeValue(this.map.writes.travelDistance, model.distanceMm)
      }
      this.model = model
      this.runStartMs = Date.now()
      this.upCycleSec = 0
      this.downCycleSec = 0
      this.resetSinceLastRun = false
    }
    await this.command(this.map.commands.start)
  }

  async stop(): Promise<void> {
    await this.command(this.map.commands.stop)
  }

  async reset(): Promise<void> {
    await this.command(this.map.commands.reset)
    this.overloadLatched = false
    this.model = null
    this.upCycleSec = 0
    this.downCycleSec = 0
    this.resetSinceLastRun = true
    this.applyStatus(this.plcStatus)
  }

  async home(): Promise<void> {
    await this.command(this.map.commands.home)
  }

  async setMode(mode: MachineMode): Promise<void> {
    const spec = mode === 'MANUAL' ? this.map.commands.modeManual : this.map.commands.modeAuto
    if (!spec) {
      throw new CommandError(
        ErrorCode.INVALID_INPUT,
        'Mode is selected on the remote pendant: hold UP and DOWN together for 5 seconds.'
      )
    }
    await this.command(spec)
  }

  async jog(direction: JogDirection, active: boolean): Promise<void> {
    const spec = direction === 'UP' ? this.map.commands.jogUp : this.map.commands.jogDown
    if (!spec) {
      throw new CommandError(ErrorCode.INVALID_INPUT, 'Jogging is only available from the remote pendant.')
    }
    await this.enqueue(() => this.writeCommandValue(spec, active ? (spec.value ?? 1) : 0))
  }

  async setSpeeds(speeds: SpeedSettings): Promise<void> {
    this.speeds = speeds
    if (!this.connected && !this.client) return
    const { upSpeed, downSpeed, jogSpeed } = this.map.writes
    if (upSpeed) await this.writeValue(upSpeed, speeds.up)
    if (downSpeed) await this.writeValue(downSpeed, speeds.down)
    if (jogSpeed) await this.writeValue(jogSpeed, speeds.jog)
  }

  setLoadCapacity(loadCapacityN: number): void {
    this.loadCapacityN = loadCapacityN
  }

  getSnapshot(): HardwareSnapshot {
    return {
      connected: this.connected,
      status: this.status,
      mode: this.mode,
      homed: this.homed,
      resetSinceLastRun: this.resetSinceLastRun,
      loadN: round(this.loadN),
      heightMm: round(this.heightMm),
      phase: phaseOf(this.status),
      upCycleSec: round(this.upCycleSec, 1),
      downCycleSec: round(this.downCycleSec, 1),
      activeModelId: this.model?.id ?? null
    }
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private pollSpecs(): RegisterSpec[] {
    const specs = [this.map.load, this.map.position, this.map.status]
    if (this.map.mode) specs.push(this.map.mode)
    if (this.map.homed) specs.push(this.map.homed)
    return specs
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollOnce()
        this.pollFailures = 0
      } catch (error) {
        // A poll still in flight when the link dropped is not a new failure.
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

    const value = (spec: RegisterSpec): number => {
      const words = extract(spec, this.blocks, results)
      if (!words) throw new Error(`register ${spec.area}:${spec.address} not in poll plan`)
      return decode(spec, words)
    }

    this.loadN = value(this.map.load)
    this.heightMm = value(this.map.position)
    const rawStatus = Math.round(value(this.map.status))
    const mapped = this.map.statusCodes[String(rawStatus)]
    if (mapped) {
      this.plcStatus = mapped
    } else {
      log.warn(`Unknown PLC status code ${rawStatus} — keeping ${this.plcStatus}`)
    }
    if (this.map.mode) {
      this.mode = Math.round(value(this.map.mode)) === this.map.manualModeValue ? 'MANUAL' : 'AUTO'
    }
    this.homed = this.map.homed
      ? value(this.map.homed) !== 0
      : this.plcStatus !== HardwareStatus.HOMING_NOT_DONE

    if (!this.connected) return

    if (
      !this.overloadLatched &&
      this.loadN > this.loadCapacityN &&
      phaseOf(this.status) !== 'idle'
    ) {
      // Protect the load cell even if the PLC has not tripped yet.
      this.overloadLatched = true
      log.warn(`Software overload trip at ${this.loadN} N (capacity ${this.loadCapacityN} N)`)
      void this.command(this.map.commands.stop).catch((error) =>
        log.error('Overload STOP command failed', error)
      )
    }

    this.applyStatus(this.overloadLatched ? HardwareStatus.OVERLOAD : this.plcStatus)
    this.tickCycleTimers()

    this.emit('telemetry', {
      timestampMs: Date.now(),
      tMs: this.model ? Date.now() - this.runStartMs : 0,
      loadN: round(this.loadN),
      heightMm: round(this.heightMm),
      phase: phaseOf(this.status),
      upCycleSec: round(this.upCycleSec, 1),
      downCycleSec: round(this.downCycleSec, 1),
      mode: this.mode,
      homed: this.homed
    })
  }

  private async readBlock(block: ReadBlock): Promise<number[]> {
    const client = this.requireClient()
    switch (block.area) {
      case 'holding':
        return (await client.readHoldingRegisters(block.start, block.count)).data
      case 'input':
        return (await client.readInputRegisters(block.start, block.count)).data
      case 'coil':
        return (await client.readCoils(block.start, block.count)).data
          .slice(0, block.count)
          .map(Number)
      case 'discrete':
        return (await client.readDiscreteInputs(block.start, block.count)).data
          .slice(0, block.count)
          .map(Number)
    }
  }

  // -------------------------------------------------------------------------
  // Status translation and cycle timing
  // -------------------------------------------------------------------------

  private applyStatus(next: HardwareStatus): void {
    const previous = this.status
    if (previous === next) return

    const prevPhase = phaseOf(previous)
    const nextPhase = phaseOf(next)
    if (prevPhase === 'up' && next !== HardwareStatus.HALT && !FAULT_STATUSES.includes(next)) {
      this.emit('cycle-complete', { phase: 'up', elapsedSec: round(this.upCycleSec, 1) })
    }
    if (prevPhase === 'down' && next === HardwareStatus.READY) {
      this.emit('cycle-complete', { phase: 'down', elapsedSec: round(this.downCycleSec, 1) })
    }
    if (nextPhase !== 'idle' && nextPhase !== prevPhase) {
      // Resume-safe: continue from whatever the counter already holds.
      const current = nextPhase === 'up' ? this.upCycleSec : this.downCycleSec
      this.phaseStartMs = Date.now() - current * 1000
    }

    this.status = next
    this.emit('status', next)
  }

  private tickCycleTimers(): void {
    const phase = phaseOf(this.status)
    if (phase === 'up') this.upCycleSec = (Date.now() - this.phaseStartMs) / 1000
    if (phase === 'down') this.downCycleSec = (Date.now() - this.phaseStartMs) / 1000
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
        throw new CommandError(
          ErrorCode.CONNECTION_FAILED,
          `Machine did not respond (${messageOf(error)})`
        )
      }
    }
    const next = this.queue.then(guarded, guarded)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async command(spec: CommandSpec): Promise<void> {
    const value = spec.value ?? 1
    await this.enqueue(() => this.writeCommandValue(spec, value))
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
    const words = encode(spec, value)
    await this.enqueue(async () => {
      const client = this.requireClient()
      if (words.length === 1) await client.writeRegister(spec.address, words[0])
      else await client.writeRegisters(spec.address, words)
    })
  }
}

function phaseOf(status: HardwareStatus): RunPhase {
  if (status === HardwareStatus.PANTO_RAISING) return 'up'
  if (status === HardwareStatus.PANTO_RETRIEVING) return 'down'
  return 'idle'
}

function describe(c: ModbusConnection): string {
  if (c.transport === 'rtu-serial') {
    return `RTU ${c.serialPath} ${c.baudRate} ${c.dataBits}${c.parity[0].toUpperCase()}${c.stopBits}, slave ${c.unitId}`
  }
  const kind = c.transport === 'rtu-tcp' ? 'RTU over TCP' : 'Modbus TCP'
  return `${kind} ${c.host}:${c.port}, slave ${c.unitId}`
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
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

/** TCP connects to an absent host otherwise wait for the OS (~75 s). */
function connectTimeoutMs(c: ModbusConnection): number {
  return Math.max(3000, c.timeoutMs * 3)
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
