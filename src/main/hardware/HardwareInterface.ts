import type EventEmitter from 'events'
import type {
  CycleCompleteEvent,
  ConnectionEvent,
  HardwareSnapshot,
  HardwareStatus,
  JogDirection,
  MachineMode,
  ModelConfig,
  SpeedSettings,
  TelemetryFrame
} from '@shared/types'

export type FaultKind = 'EMERGENCY' | 'SERVO_ERROR' | 'SERVO_OFF' | 'OVERLOAD' | 'DISCONNECT'

export interface HardwareEvents {
  telemetry: (frame: TelemetryFrame) => void
  status: (status: HardwareStatus) => void
  connection: (event: ConnectionEvent) => void
  'cycle-complete': (event: CycleCompleteEvent) => void
}

/**
 * Contract every hardware driver implements. `MockHardware` simulates it today;
 * a Modbus RTU driver will implement the same surface once the register map is
 * available, so nothing above this layer changes.
 */
export interface HardwareInterface extends EventEmitter {
  connect(): Promise<void>
  disconnect(): Promise<void>

  start(model: ModelConfig): Promise<void>
  stop(): Promise<void>
  reset(): Promise<void>
  home(): Promise<void>

  setMode(mode: MachineMode): Promise<void>
  jog(direction: JogDirection, active: boolean): Promise<void>
  setSpeeds(speeds: SpeedSettings): Promise<void>

  getSnapshot(): HardwareSnapshot

  /** Load above this trips OVERLOAD. */
  setLoadCapacity(loadCapacityN: number): void

  /** Dev/demo only — simulates faults that would otherwise come from the machine. */
  forceFault?(kind: FaultKind): Promise<void>

  on<E extends keyof HardwareEvents>(event: E, listener: HardwareEvents[E]): this
  emit<E extends keyof HardwareEvents>(event: E, ...args: Parameters<HardwareEvents[E]>): boolean
}
