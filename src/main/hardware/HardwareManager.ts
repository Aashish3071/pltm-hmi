import { EventEmitter } from 'events'
import type {
  HardwareConfig,
  HardwareDriver,
  HardwareSnapshot,
  JogDirection,
  MachineMode,
  ModelConfig,
  SpeedSettings
} from '@shared/types'
import { settingsRepo } from '../db/repositories'
import { log } from '../logger'
import {
  DEFAULT_CONNECTION,
  DEFAULT_REGISTER_MAP,
  validateConnection,
  validateDriver,
  validateRegisterMap
} from './config'
import type { FaultKind, HardwareEvents, HardwareInterface } from './HardwareInterface'
import { MockHardware } from './MockHardware'
import { ModbusHardware } from './ModbusHardware'

const RECONNECT_INTERVAL_MS = 3000
/** A held jog button must be re-confirmed within this window or motion stops. */
export const JOG_WATCHDOG_MS = 600

const EVENTS: (keyof HardwareEvents)[] = ['telemetry', 'status', 'connection', 'cycle-complete']

/**
 * The single hardware object the rest of the app uses. It delegates to the
 * configured driver, can swap drivers at runtime, keeps reconnecting after a
 * link loss, and enforces a dead-man watchdog on manual jogging.
 */
export class HardwareHub extends EventEmitter implements HardwareInterface {
  private driver: HardwareInterface
  private kind: HardwareDriver
  private connecting = false
  private supervisor: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private jogState: { direction: JogDirection; lastPing: number } | null = null
  private lastConnectError = ''

  constructor(driver: HardwareInterface, kind: HardwareDriver) {
    super()
    this.driver = driver
    this.kind = kind
    this.attach(driver)
  }

  get driverKind(): HardwareDriver {
    return this.kind
  }

  /** Replaces the active driver; the old one is disconnected and detached. */
  async setDriver(driver: HardwareInterface, kind: HardwareDriver): Promise<void> {
    const old = this.driver
    this.jogState = null
    for (const event of EVENTS) old.removeAllListeners(event)
    await old.disconnect().catch(() => undefined)
    this.driver = driver
    this.kind = kind
    this.attach(driver)
    this.emit('connection', { connected: false })
    await this.tryConnect()
  }

  private attach(driver: HardwareInterface): void {
    for (const event of EVENTS) {
      ;(driver as EventEmitter).on(event, (payload: unknown) => {
        if (event === 'connection' && !(payload as { connected: boolean }).connected) {
          this.jogState = null
        }
        this.emit(event, payload)
      })
    }
  }

  /** Starts background reconnection and the jog watchdog. */
  startSupervision(): void {
    if (!this.supervisor) {
      this.supervisor = setInterval(() => {
        if (!this.driver.getSnapshot().connected) void this.tryConnect()
      }, RECONNECT_INTERVAL_MS)
    }
    if (!this.watchdog) {
      this.watchdog = setInterval(() => this.checkJogWatchdog(), 100)
    }
  }

  stopSupervision(): void {
    if (this.supervisor) clearInterval(this.supervisor)
    if (this.watchdog) clearInterval(this.watchdog)
    this.supervisor = null
    this.watchdog = null
  }

  async tryConnect(): Promise<boolean> {
    if (this.connecting || this.driver.getSnapshot().connected) return true
    this.connecting = true
    try {
      await this.driver.connect()
      this.lastConnectError = ''
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Log once per distinct failure rather than every retry.
      if (message !== this.lastConnectError) log.warn(`Connect failed: ${message}`)
      this.lastConnectError = message
      return false
    } finally {
      this.connecting = false
    }
  }

  get connectError(): string {
    return this.lastConnectError
  }

  private checkJogWatchdog(): void {
    if (!this.jogState) return
    if (Date.now() - this.jogState.lastPing <= JOG_WATCHDOG_MS) return
    const { direction } = this.jogState
    this.jogState = null
    log.warn(`Jog ${direction} stopped by watchdog (no keep-alive from the UI)`)
    void this.driver.jog(direction, false).catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // HardwareInterface — delegation
  // -------------------------------------------------------------------------

  connect(): Promise<void> {
    return this.driver.connect()
  }

  disconnect(): Promise<void> {
    this.jogState = null
    return this.driver.disconnect()
  }

  start(model: ModelConfig): Promise<void> {
    return this.driver.start(model)
  }

  stop(): Promise<void> {
    return this.driver.stop()
  }

  reset(): Promise<void> {
    this.jogState = null
    return this.driver.reset()
  }

  home(): Promise<void> {
    return this.driver.home()
  }

  setMode(mode: MachineMode): Promise<void> {
    this.jogState = null
    return this.driver.setMode(mode)
  }

  /**
   * `active: true` must be repeated while the button is held (keep-alive); only
   * the first call is sent to the machine.
   */
  async jog(direction: JogDirection, active: boolean): Promise<void> {
    if (!active) {
      const current = this.jogState
      this.jogState = null
      await this.driver.jog(current?.direction ?? direction, false)
      return
    }
    if (this.jogState && this.jogState.direction === direction) {
      this.jogState.lastPing = Date.now()
      return
    }
    if (this.jogState) await this.driver.jog(this.jogState.direction, false)
    await this.driver.jog(direction, true)
    this.jogState = { direction, lastPing: Date.now() }
  }

  setSpeeds(speeds: SpeedSettings): Promise<void> {
    return this.driver.setSpeeds(speeds)
  }

  setLoadCapacity(loadCapacityN: number): void {
    this.driver.setLoadCapacity(loadCapacityN)
  }

  setHeightCapacity(heightCapacityMm: number): void {
    if (this.driver instanceof MockHardware) this.driver.setHeightCapacity(heightCapacityMm)
  }

  getSnapshot(): HardwareSnapshot {
    return this.driver.getSnapshot()
  }

  async forceFault(kind: FaultKind): Promise<void> {
    if (!this.driver.forceFault) {
      throw new Error('Fault simulation is only available on the simulator')
    }
    this.jogState = null
    await this.driver.forceFault(kind)
  }

  get supportsFaultSimulation(): boolean {
    return typeof this.driver.forceFault === 'function'
  }
}

let hub: HardwareHub | null = null

export function loadHardwareConfig(): HardwareConfig {
  const s = settingsRepo.getAll()
  let driver: HardwareDriver = 'simulator'
  let connection = DEFAULT_CONNECTION
  let registerMap = DEFAULT_REGISTER_MAP
  try {
    driver = validateDriver(s.hardware_driver ?? 'simulator')
  } catch (error) {
    log.error('Invalid stored hardware driver, using simulator', error)
  }
  try {
    if (s.modbus_connection) connection = validateConnection(JSON.parse(s.modbus_connection))
  } catch (error) {
    log.error('Invalid stored Modbus connection, using defaults', error)
  }
  try {
    if (s.modbus_register_map) registerMap = validateRegisterMap(JSON.parse(s.modbus_register_map))
  } catch (error) {
    log.error('Invalid stored register map, using defaults', error)
  }
  return { driver, connection, registerMap }
}

export function buildDriver(
  config: HardwareConfig,
  options: { probeOnly?: boolean } = {}
): HardwareInterface {
  const s = settingsRepo.getAll()
  const loadCapacityN = Number(s.load_capacity_n ?? 250)
  const heightCapacityMm = Number(s.height_capacity_mm ?? 4000)
  const speeds = settingsRepo.getSpeeds()
  if (config.driver === 'modbus') {
    return new ModbusHardware(
      config.connection,
      config.registerMap,
      speeds,
      loadCapacityN,
      options.probeOnly
    )
  }
  return new MockHardware({ loadCapacityN, heightCapacityMm, speeds })
}

/**
 * Single place where the driver is chosen — from the admin's Settings choice.
 * The simulator is the default until a real register map is configured.
 */
export function initHardware(): HardwareHub {
  const config = loadHardwareConfig()
  hub = new HardwareHub(buildDriver(config), config.driver)
  return hub
}

export function getHardware(): HardwareHub {
  if (!hub) throw new Error('Hardware not initialised — call initHardware() first')
  return hub
}
