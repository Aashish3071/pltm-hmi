import { StatusCode, type MachineMode, type ModelConfig, type SpeedSettings } from '@shared/types'
import { sortedPoints } from '@shared/analysis'

export type FaultKind = 'EMERGENCY' | 'SERVO_ERROR' | 'SERVO_OFF' | 'OVERLOAD' | 'DISCONNECT'

const FAULTS: number[] = [
  StatusCode.EMERGENCY_PRESSED,
  StatusCode.SERVO_ERROR,
  StatusCode.OVERLOAD,
  StatusCode.SERVO_OFF
]
/** How long the PLC dwells at the top (RAISING COMPLETED) before lowering. */
const TOP_DWELL_MS = 1500
/** How long CYCLE COMPLETED is shown before the PLC returns to READY. */
const COMPLETE_HOLD_MS = 1500

/**
 * Behaves like the pantograph tester's PLC as the app sees it:
 * START raises to the travel distance at the up speed, dwells, lowers at the
 * down speed and reports CYCLE COMPLETED, then READY. STOP halts (HALT) until
 * the next START. The load follows the selected model's profile so the graph
 * traces a realistic curve. Used by the simulator and by the test PLCs.
 */
export class PlcEmulator {
  code: number = StatusCode.HOMING_NOT_DONE
  positionMm = 0
  loadN = 0
  upTimeSec = 0
  downTimeSec = 0
  mode: MachineMode = 'AUTO'
  homed = false
  speeds: SpeedSettings = { up: 50, down: 50, jog: 50 }
  distanceMm = 0

  private phase: 'idle' | 'up' | 'top' | 'down' | 'done' | 'homing' = 'idle'
  private halted = false
  private phaseElapsedMs = 0
  private model: Pick<ModelConfig, 'points' | 'distanceMm'> | null = null

  setModel(model: Pick<ModelConfig, 'points' | 'distanceMm'> | null): void {
    this.model = model
    if (model && !this.distanceMm) this.distanceMm = model.distanceMm
  }

  start(): void {
    if (FAULTS.includes(this.code)) return
    if (this.halted) {
      this.halted = false
      this.code = this.phaseCode()
      return
    }
    if (!this.homed) {
      this.code = StatusCode.HOMING_NOT_DONE
      return
    }
    if (this.phase === 'up' || this.phase === 'down' || this.phase === 'top') return
    const travel = this.distanceMm || this.model?.distanceMm || 0
    if (travel <= 0) return
    this.distanceMm = travel
    this.phase = 'up'
    this.phaseElapsedMs = 0
    this.upTimeSec = 0
    this.downTimeSec = 0
    this.code = StatusCode.PANTO_RAISING
  }

  stop(): void {
    if (this.phase === 'up' || this.phase === 'down' || this.phase === 'top' || this.phase === 'homing') {
      this.halted = true
      this.code = StatusCode.HALT
    }
  }

  reset(): void {
    const wasMoving = this.phase !== 'idle' && this.phase !== 'done'
    this.phase = 'idle'
    this.halted = false
    this.upTimeSec = 0
    this.downTimeSec = 0
    if (wasMoving && this.positionMm > 1) this.homed = false
    this.code = this.homed ? StatusCode.READY : StatusCode.HOMING_NOT_DONE
  }

  home(): void {
    if (FAULTS.includes(this.code)) return
    if (this.phase === 'up' || this.phase === 'down' || this.phase === 'top') return
    this.halted = false
    this.phase = 'homing'
  }

  fault(kind: Exclude<FaultKind, 'DISCONNECT'>): void {
    this.halted = false
    this.phase = 'idle'
    this.code = {
      EMERGENCY: StatusCode.EMERGENCY_PRESSED,
      SERVO_ERROR: StatusCode.SERVO_ERROR,
      SERVO_OFF: StatusCode.SERVO_OFF,
      OVERLOAD: StatusCode.OVERLOAD
    }[kind]
  }

  /** Advances the simulation by `dtMs`. */
  tick(dtMs: number): void {
    const dt = dtMs / 1000
    if (!this.halted) {
      switch (this.phase) {
        case 'homing':
          this.positionMm = Math.max(0, this.positionMm - Math.max(this.speeds.jog, 1) * 4 * dt)
          if (this.positionMm <= 0) {
            this.phase = 'idle'
            this.homed = true
            this.code = StatusCode.READY
          }
          break
        case 'up':
          this.phaseElapsedMs += dtMs
          this.upTimeSec = Math.floor(this.phaseElapsedMs / 1000)
          this.positionMm = Math.min(this.distanceMm, this.positionMm + this.speeds.up * dt)
          if (this.positionMm >= this.distanceMm) this.enter('top', StatusCode.PANTO_RAISING_COMPLETED)
          break
        case 'top':
          this.phaseElapsedMs += dtMs
          if (this.phaseElapsedMs >= TOP_DWELL_MS) this.enter('down', StatusCode.PANTO_RETRIEVING)
          break
        case 'down':
          this.phaseElapsedMs += dtMs
          this.downTimeSec = Math.floor(this.phaseElapsedMs / 1000)
          this.positionMm = Math.max(0, this.positionMm - this.speeds.down * dt)
          if (this.positionMm <= 0) this.enter('done', StatusCode.CYCLE_COMPLETED)
          break
        case 'done':
          this.phaseElapsedMs += dtMs
          if (this.phaseElapsedMs >= COMPLETE_HOLD_MS) {
            this.phase = 'idle'
            this.code = StatusCode.READY
          }
          break
      }
    }
    this.loadN = this.loadAt()
  }

  /** The PLC's status string: "load×100 position status uptime downtime mode". */
  statusString(): string {
    const fields = [
      Math.round(this.loadN * 100),
      Math.round(this.positionMm),
      this.code,
      this.upTimeSec,
      this.downTimeSec,
      this.mode === 'MANUAL' ? 1 : 2
    ]
    return fields.map((f) => String(f).padStart(8)).join('')
  }

  private enter(phase: typeof this.phase, code: number): void {
    this.phase = phase
    this.phaseElapsedMs = 0
    this.code = code
  }

  private phaseCode(): number {
    switch (this.phase) {
      case 'up':
        return StatusCode.PANTO_RAISING
      case 'top':
        return StatusCode.PANTO_RAISING_COMPLETED
      case 'down':
        return StatusCode.PANTO_RETRIEVING
      case 'homing':
        return StatusCode.HOMING_NOT_DONE
      default:
        return StatusCode.READY
    }
  }

  /**
   * The model's 9 points form a closed loop: up to the top along the raising
   * branch, back down along the lowering branch. Contact force sits a little
   * inside the reference band with friction noise, like a real pantograph.
   */
  private loadAt(): number {
    if (!this.model || this.model.points.length < 2) return 0
    const moving = this.phase === 'up' || this.phase === 'top' || this.phase === 'down'
    if (!moving) return this.phase === 'done' ? this.branchLoad('down') : 0
    const branch = this.phase === 'down' ? 'down' : 'up'
    const noise = (Math.random() - 0.5) * 3
    return Math.max(0, this.branchLoad(branch) + noise)
  }

  private branchLoad(branch: 'up' | 'down'): number {
    const points = sortedPoints(this.model!)
    const top = Math.max(...points.map((p) => p.heightMm))
    const firstPeak = points.findIndex((p) => p.heightMm === top)
    const lastPeak = points.length - 1 - [...points].reverse().findIndex((p) => p.heightMm === top)
    const raw = branch === 'down' ? points.slice(lastPeak) : points.slice(0, firstPeak + 1)
    const seen = new Set<number>()
    const usable = raw.filter((p) => !seen.has(p.heightMm) && seen.add(p.heightMm))
    const sorted = (usable.length >= 2 ? usable : points).sort((a, b) => a.heightMm - b.heightMm)
    const h = this.positionMm
    if (h <= sorted[0].heightMm) return sorted[0].loadN
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]
      const b = sorted[i + 1]
      if (h >= a.heightMm && h <= b.heightMm) {
        const span = b.heightMm - a.heightMm
        return span === 0 ? b.loadN : a.loadN + ((b.loadN - a.loadN) * (h - a.heightMm)) / span
      }
    }
    return sorted[sorted.length - 1].loadN
  }
}
