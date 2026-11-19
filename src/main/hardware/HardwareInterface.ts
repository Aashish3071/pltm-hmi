import type EventEmitter from 'events'
import type { ModelConfig, PlcState, SpeedSettings } from '@shared/types'
import type { FaultKind } from './PlcEmulator'

export type { FaultKind }

export interface HardwareEvents {
  /** Every poll of the PLC. */
  state: (state: PlcState) => void
  connection: (connected: boolean) => void
}

/**
 * What the app needs from the machine: poll the PLC's six values, and set
 * the command bits. The PLC runs the test cycle and
 * its interlocks itself; drivers only translate.
 */
export interface HardwareInterface extends EventEmitter {
  connect(): Promise<void>
  disconnect(): Promise<void>

  /** Writes the model's travel distance, clears STOP (resume) and sets START. */
  start(model: ModelConfig): Promise<void>
  stop(): Promise<void>
  reset(): Promise<void>
  home(): Promise<void>

  /** Up, down and jog speeds (mm/s) to the PLC. */
  writeSpeeds(speeds: SpeedSettings): Promise<void>

  getState(): PlcState

  /** Controller only: sends the overload and travel limits again (after the admin changes them). */
  refreshLimits?(): Promise<void>

  /** Simulator only — faults that would otherwise come from the machine. */
  forceFault?(kind: FaultKind): Promise<void>

  on<E extends keyof HardwareEvents>(event: E, listener: HardwareEvents[E]): this
  emit<E extends keyof HardwareEvents>(event: E, ...args: Parameters<HardwareEvents[E]>): boolean
}

export function disconnectedState(previous?: PlcState): PlcState {
  return {
    connected: false,
    timestampMs: Date.now(),
    loadN: previous?.loadN ?? 0,
    positionMm: previous?.positionMm ?? 0,
    code: 100,
    upTimeSec: previous?.upTimeSec ?? 0,
    downTimeSec: previous?.downTimeSec ?? 0,
    mode: previous?.mode ?? null
  }
}

/**
 * Parses the status string: "load×100 position status uptime downtime mode".
 * Returns null when it does not hold six numbers (such polls are skipped).
 */
export function parseStatusString(text: string, loadDivisor: number): Omit<PlcState, 'connected' | 'timestampMs'> | null {
  const parts = text.trim().split(/\s+/)
  if (parts.length < 6) return null
  const n = parts.slice(0, 6).map((p) => Number(p))
  if (n.some((v) => !Number.isFinite(v))) return null
  const [load, position, code, up, down, mode] = n
  return {
    loadN: Math.trunc(load) / (loadDivisor || 1),
    positionMm: Math.trunc(position),
    code: Math.trunc(code),
    upTimeSec: up,
    downTimeSec: down,
    mode: mode === 1 ? 'MANUAL' : mode === 2 ? 'AUTO' : null
  }
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
