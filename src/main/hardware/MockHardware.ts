import { EventEmitter } from 'events'
import { ErrorCode, type ModelConfig, type PlcState, type SpeedSettings } from '@shared/types'
import { CommandError } from '../errors'
import { disconnectedState, type FaultKind, type HardwareInterface } from './HardwareInterface'
import { PlcEmulator } from './PlcEmulator'

const TICK_MS = 25
/** How long a simulated cable pull keeps the machine unreachable. */
const SIMULATED_OUTAGE_MS = 5000

/** The built-in simulator: an emulated PLC in the same process. */
export class MockHardware extends EventEmitter implements HardwareInterface {
  readonly plc = new PlcEmulator()
  private connected = false
  private timer: NodeJS.Timeout | null = null
  private outageUntil = 0
  private last: PlcState = disconnectedState()

  constructor(speeds?: SpeedSettings) {
    super()
    if (speeds) this.plc.speeds = speeds
  }

  async connect(): Promise<void> {
    if (this.connected) return
    if (Date.now() < this.outageUntil) {
      throw new CommandError(ErrorCode.CONNECTION_FAILED, 'Simulated machine is unreachable')
    }
    this.connected = true
    this.emit('connection', true)
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const was = this.connected
    this.connected = false
    this.last = disconnectedState(this.last)
    if (was) {
      this.emit('connection', false)
      this.emit('state', this.last)
    }
  }

  async start(model: ModelConfig): Promise<void> {
    this.requireConnected()
    this.plc.setModel(model)
    this.plc.distanceMm = model.distanceMm
    this.plc.start()
  }

  async stop(): Promise<void> {
    this.requireConnected()
    this.plc.stop()
  }

  async reset(): Promise<void> {
    this.requireConnected()
    this.plc.reset()
  }

  async home(): Promise<void> {
    this.requireConnected()
    this.plc.home()
  }

  async writeSpeeds(speeds: SpeedSettings): Promise<void> {
    this.plc.speeds = { ...speeds }
  }

  getState(): PlcState {
    return this.last
  }

  async forceFault(kind: FaultKind): Promise<void> {
    if (kind === 'DISCONNECT') {
      this.outageUntil = Date.now() + SIMULATED_OUTAGE_MS
      await this.disconnect()
      return
    }
    this.plc.fault(kind)
  }

  private requireConnected(): void {
    if (!this.connected) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
  }

  private tick(): void {
    this.plc.tick(TICK_MS)
    this.last = {
      connected: true,
      timestampMs: Date.now(),
      // The PLC reports load ×100 as an integer, so the app sees 0.01 N steps.
      loadN: Math.round(this.plc.loadN * 100) / 100,
      positionMm: Math.round(this.plc.positionMm),
      code: this.plc.code,
      upTimeSec: this.plc.upTimeSec,
      downTimeSec: this.plc.downTimeSec,
      mode: this.plc.mode
    }
    this.emit('state', this.last)
  }
}
