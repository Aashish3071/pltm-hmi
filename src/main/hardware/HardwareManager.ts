import { EventEmitter } from 'events'
import type {
  HardwareConfig,
  HardwareDriver,
  ModelConfig,
  PlcState,
  SpeedSettings
} from '@shared/types'
import { settingsRepo } from '../db/repositories'
import { log } from '../logger'
import { DEFAULT_HARDWARE_CONFIG, validateHardwareConfig } from './config'
import type { FaultKind, HardwareEvents, HardwareInterface } from './HardwareInterface'
import { MockHardware } from './MockHardware'
import { ModbusHardware } from './ModbusHardware'
import { S7Hardware } from './S7Hardware'

const RECONNECT_INTERVAL_MS = 3000
const EVENTS: (keyof HardwareEvents)[] = ['state', 'connection']

/**
 * The single hardware object the rest of the app uses. It delegates to the
 * configured driver, can swap drivers at runtime, and keeps reconnecting after
 * a link loss (the UI shows ETHERNET DISCONNECTED meanwhile).
 */
export class HardwareHub extends EventEmitter implements HardwareInterface {
  private driver: HardwareInterface
  private kind: HardwareDriver
  /** The driver a connect is in progress for (a slow connect to an old address must not block a new driver). */
  private connecting: HardwareInterface | null = null
  private supervisor: NodeJS.Timeout | null = null
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

  get connectError(): string {
    return this.lastConnectError
  }

  /** Replaces the active driver; the old one is disconnected and detached. */
  async setDriver(driver: HardwareInterface, kind: HardwareDriver): Promise<void> {
    const old = this.driver
    for (const event of EVENTS) old.removeAllListeners(event)
    await old.disconnect().catch(() => undefined)
    this.driver = driver
    this.kind = kind
    this.attach(driver)
    this.emit('connection', false)
    this.emit('state', driver.getState())
    await this.tryConnect()
  }

  private attach(driver: HardwareInterface): void {
    for (const event of EVENTS) {
      ;(driver as EventEmitter).on(event, (payload: unknown) => this.emit(event, payload as never))
    }
    // On every (re)connect the PLC gets the speeds saved now, not when the driver was made.
    ;(driver as EventEmitter).on('connection', (connected: boolean) => {
      if (!connected) return
      void driver.writeSpeeds(settingsRepo.getSpeeds()).catch((error) =>
        log.warn('Could not write speeds after connect', error instanceof Error ? error.message : String(error))
      )
    })
  }

  startSupervision(): void {
    if (this.supervisor) return
    this.supervisor = setInterval(() => {
      if (!this.driver.getState().connected) void this.tryConnect()
    }, RECONNECT_INTERVAL_MS)
  }

  stopSupervision(): void {
    if (this.supervisor) clearInterval(this.supervisor)
    this.supervisor = null
  }

  async tryConnect(): Promise<boolean> {
    const driver = this.driver
    if (this.connecting === driver || driver.getState().connected) return true
    this.connecting = driver
    try {
      await driver.connect()
      if (driver !== this.driver) {
        // Replaced while connecting: let go of the old link.
        await driver.disconnect().catch(() => undefined)
        return false
      }
      this.lastConnectError = ''
      return true
    } catch (error) {
      if (driver !== this.driver) return false
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.lastConnectError) log.warn(`Connect failed: ${message}`)
      this.lastConnectError = message
      return false
    } finally {
      if (this.connecting === driver) this.connecting = null
    }
  }

  connect(): Promise<void> {
    return this.driver.connect()
  }

  disconnect(): Promise<void> {
    return this.driver.disconnect()
  }

  start(model: ModelConfig): Promise<void> {
    return this.driver.start(model)
  }

  stop(): Promise<void> {
    return this.driver.stop()
  }

  reset(): Promise<void> {
    return this.driver.reset()
  }

  home(): Promise<void> {
    return this.driver.home()
  }

  writeSpeeds(speeds: SpeedSettings): Promise<void> {
    return this.driver.writeSpeeds(speeds)
  }

  getState(): PlcState {
    return this.driver.getState()
  }

  async forceFault(kind: FaultKind): Promise<void> {
    if (!this.driver.forceFault) throw new Error('Fault simulation is only available on the simulator')
    await this.driver.forceFault(kind)
  }
}

let hub: HardwareHub | null = null

export function loadHardwareConfig(): HardwareConfig {
  const stored = settingsRepo.get('hardware_config')
  if (!stored) return DEFAULT_HARDWARE_CONFIG
  try {
    return validateHardwareConfig(JSON.parse(stored))
  } catch (error) {
    log.error('Invalid stored hardware config, using defaults', error)
    return DEFAULT_HARDWARE_CONFIG
  }
}

export function buildDriver(config: HardwareConfig, options: { probeOnly?: boolean } = {}): HardwareInterface {
  switch (config.driver) {
    case 's7':
      return new S7Hardware(config.s7.connection, config.s7.map, options.probeOnly)
    case 'modbus':
      return new ModbusHardware(config.modbus.connection, config.modbus.map, options.probeOnly)
    default:
      return new MockHardware(settingsRepo.getSpeeds())
  }
}

/** The driver comes from the admin's choice; Siemens S7 out of the box. */
export function initHardware(): HardwareHub {
  const config = loadHardwareConfig()
  hub = new HardwareHub(buildDriver(config), config.driver)
  return hub
}

export function getHardware(): HardwareHub {
  if (!hub) throw new Error('Hardware not initialised — call initHardware() first')
  return hub
}
