import { EventEmitter } from 'events'
import {
  ErrorCode,
  FAULT_STATUSES,
  HardwareStatus,
  type HardwareSnapshot,
  type JogDirection,
  type MachineMode,
  type ModelConfig,
  type ModelPoint,
  type RunPhase,
  type SpeedSettings
} from '@shared/types'
import { CommandError } from '../errors'
import type { FaultKind, HardwareInterface } from './HardwareInterface'

const TICK_MS = 100
/** How long a simulated cable pull keeps the machine unreachable. */
const SIMULATED_OUTAGE_MS = 5000

/**
 * Simulates the PLTM: drives height from the configured speeds and derives load
 * by interpolating the selected model's (load, height) control points, so the
 * live graph traces the same envelope the real machine would produce.
 */
export class MockHardware extends EventEmitter implements HardwareInterface {
  private connected = false
  private status: HardwareStatus = HardwareStatus.DISCONNECTED
  private mode: MachineMode = 'AUTO'
  private homed = false
  private resetSinceLastRun = true
  private heightMm = 0
  private loadN = 0
  private phase: RunPhase = 'idle'
  private model: ModelConfig | null = null
  private speeds: SpeedSettings = { up: 50, down: 50, jog: 50 }
  private loadCapacityN = 250
  private heightCapacityMm = 4000
  private outageUntil = 0

  private timer: NodeJS.Timeout | null = null
  private runStartMs = 0
  private phaseStartMs = 0
  private upCycleSec = 0
  private downCycleSec = 0
  private jogging: { direction: JogDirection } | null = null

  constructor(options?: {
    loadCapacityN?: number
    heightCapacityMm?: number
    speeds?: SpeedSettings
  }) {
    super()
    if (options?.loadCapacityN) this.loadCapacityN = options.loadCapacityN
    if (options?.heightCapacityMm) this.heightCapacityMm = options.heightCapacityMm
    if (options?.speeds) this.speeds = options.speeds
  }

  async connect(): Promise<void> {
    if (this.connected) return
    if (Date.now() < this.outageUntil) {
      throw new CommandError(ErrorCode.CONNECTION_FAILED, 'Simulated machine is unreachable')
    }
    this.connected = true
    this.emit('connection', { connected: true })
    this.setStatus(this.homed ? HardwareStatus.READY : HardwareStatus.HOMING_NOT_DONE)
    this.startTicking()
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.stopTicking()
    this.phase = 'idle'
    this.emit('connection', { connected: false })
    this.setStatus(HardwareStatus.DISCONNECTED)
  }

  async start(model: ModelConfig): Promise<void> {
    this.model = model
    const resuming = this.status === HardwareStatus.HALT
    if (!resuming) {
      this.runStartMs = Date.now()
      this.upCycleSec = 0
      this.downCycleSec = 0
      this.heightMm = 0
      this.phase = 'up'
      this.phaseStartMs = Date.now()
      this.resetSinceLastRun = false
    } else {
      this.phaseStartMs = Date.now() - (this.phase === 'up' ? this.upCycleSec : this.downCycleSec) * 1000
    }
    this.setStatus(
      this.phase === 'down' ? HardwareStatus.PANTO_RETRIEVING : HardwareStatus.PANTO_RAISING
    )
  }

  async stop(): Promise<void> {
    this.setStatus(HardwareStatus.HALT)
  }

  async reset(): Promise<void> {
    this.phase = 'idle'
    this.loadN = 0
    this.upCycleSec = 0
    this.downCycleSec = 0
    this.model = null
    this.jogging = null
    this.resetSinceLastRun = true
    // Reset clears the fault but leaves the arm where it stopped; if that is
    // not the zero position the operator must home again.
    if (this.heightMm > 0.5) this.homed = false
    this.setStatus(this.homed ? HardwareStatus.READY : HardwareStatus.HOMING_NOT_DONE)
  }

  async home(): Promise<void> {
    this.jogging = null
    this.homed = true
    this.heightMm = 0
    this.loadN = 0
    this.phase = 'idle'
    this.setStatus(HardwareStatus.READY)
  }

  async setMode(mode: MachineMode): Promise<void> {
    this.mode = mode
    this.jogging = null
  }

  async jog(direction: JogDirection, active: boolean): Promise<void> {
    this.jogging = active ? { direction } : null
  }

  async setSpeeds(speeds: SpeedSettings): Promise<void> {
    this.speeds = speeds
  }

  setLoadCapacity(loadCapacityN: number): void {
    this.loadCapacityN = loadCapacityN
  }

  setHeightCapacity(heightCapacityMm: number): void {
    this.heightCapacityMm = heightCapacityMm
  }

  async forceFault(kind: FaultKind): Promise<void> {
    switch (kind) {
      case 'EMERGENCY':
        this.phase = 'idle'
        this.setStatus(HardwareStatus.EMERGENCY_PRESSED)
        break
      case 'SERVO_ERROR':
        this.phase = 'idle'
        this.setStatus(HardwareStatus.SERVO_ERROR)
        break
      case 'SERVO_OFF':
        this.phase = 'idle'
        this.setStatus(HardwareStatus.SERVO_OFF)
        break
      case 'OVERLOAD':
        this.phase = 'idle'
        this.loadN = this.loadCapacityN + 10
        this.setStatus(HardwareStatus.OVERLOAD)
        break
      case 'DISCONNECT':
        this.outageUntil = Date.now() + SIMULATED_OUTAGE_MS
        this.phase = 'idle'
        this.jogging = null
        await this.disconnect()
        break
    }
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
      phase: this.effectivePhase(),
      upCycleSec: round(this.upCycleSec, 1),
      downCycleSec: round(this.downCycleSec, 1),
      activeModelId: this.model?.id ?? null
    }
  }

  /**
   * `phase` is retained across a HALT so the run can resume, but a paused
   * machine must report `idle` — otherwise the graph and the run recorder keep
   * treating it as an in-progress cycle.
   */
  private effectivePhase(): RunPhase {
    return this.status === HardwareStatus.PANTO_RAISING ||
      this.status === HardwareStatus.PANTO_RETRIEVING
      ? this.phase
      : 'idle'
  }

  private setStatus(status: HardwareStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }

  private startTicking(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  private stopTicking(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    const dt = TICK_MS / 1000

    if (this.mode === 'MANUAL' && this.jogging && !FAULT_STATUSES.includes(this.status)) {
      const delta = this.speeds.jog * dt * (this.jogging.direction === 'UP' ? 1 : -1)
      this.heightMm = clamp(this.heightMm + delta, 0, this.heightCapacityMm)
      if (this.homed && this.heightMm > 0.5) {
        this.homed = false
        this.setStatus(HardwareStatus.HOMING_NOT_DONE)
      }
    } else if (this.status === HardwareStatus.PANTO_RAISING && this.model) {
      this.heightMm += this.speeds.up * dt
      this.upCycleSec = (Date.now() - this.phaseStartMs) / 1000
      if (this.heightMm >= this.model.distanceMm) {
        this.heightMm = this.model.distanceMm
        this.emit('cycle-complete', { phase: 'up', elapsedSec: round(this.upCycleSec, 1) })
        this.setStatus(HardwareStatus.PANTO_RAISING_COMPLETED)
        this.phase = 'down'
        this.phaseStartMs = Date.now()
        this.setStatus(HardwareStatus.PANTO_RETRIEVING)
      }
    } else if (this.status === HardwareStatus.PANTO_RETRIEVING && this.model) {
      this.heightMm -= this.speeds.down * dt
      this.downCycleSec = (Date.now() - this.phaseStartMs) / 1000
      if (this.heightMm <= 0) {
        this.heightMm = 0
        this.emit('cycle-complete', { phase: 'down', elapsedSec: round(this.downCycleSec, 1) })
        this.phase = 'idle'
        this.setStatus(HardwareStatus.READY)
      }
    }

    this.loadN = this.model ? this.loadAt(this.heightMm, this.effectivePhase()) : 0

    if (this.loadN > this.loadCapacityN && this.effectivePhase() !== 'idle') {
      this.phase = 'idle'
      this.setStatus(HardwareStatus.OVERLOAD)
    }

    this.emit('telemetry', {
      timestampMs: Date.now(),
      tMs: this.runStartMs ? Date.now() - this.runStartMs : 0,
      loadN: round(this.loadN),
      heightMm: round(this.heightMm),
      phase: this.effectivePhase(),
      upCycleSec: round(this.upCycleSec, 1),
      downCycleSec: round(this.downCycleSec, 1),
      mode: this.mode,
      homed: this.homed
    })
  }

  /**
   * The model's points form a closed loop: rows ascend in height to the peak
   * (the up curve), then descend back (the down curve). Interpolate load on
   * whichever branch matches the current phase.
   */
  private loadAt(height: number, phase: RunPhase): number {
    if (!this.model || this.model.points.length < 2) return 0
    const points = [...this.model.points].sort((a, b) => a.rowIndex - b.rowIndex)
    const peakIndex = points.reduce(
      (best, p, i) => (p.heightMm > points[best].heightMm ? i : best),
      0
    )
    const branch = phase === 'down' ? points.slice(peakIndex) : points.slice(0, peakIndex + 1)
    const usable = branch.length >= 2 ? branch : points
    const noise = (Math.random() - 0.5) * 0.4
    return interpolateByHeight(usable, height) + (phase === 'idle' ? 0 : noise)
  }
}

function interpolateByHeight(points: ModelPoint[], height: number): number {
  const sorted = [...points].sort((a, b) => a.heightMm - b.heightMm)
  if (height <= sorted[0].heightMm) return sorted[0].loadN
  const last = sorted[sorted.length - 1]
  if (height >= last.heightMm) return last.loadN
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (height >= a.heightMm && height <= b.heightMm) {
      const span = b.heightMm - a.heightMm
      if (span === 0) return b.loadN
      const ratio = (height - a.heightMm) / span
      return a.loadN + (b.loadN - a.loadN) * ratio
    }
  }
  return last.loadN
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
