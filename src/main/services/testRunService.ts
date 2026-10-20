import {
  ErrorCode,
  FAULT_STATUSES,
  HardwareStatus,
  type JogDirection,
  type MachineMode,
  type StartRunRequest,
  type TelemetryFrame
} from '@shared/types'
import { getHardware } from '../hardware/HardwareManager'
import { modelsRepo, testRunsRepo, usersRepo } from '../db/repositories'
import { CommandError } from '../errors'

export { CommandError }

const PART_NO_MAX = 40

let activeRunId: number | null = null
let pointBuffer: TelemetryFrame[] = []
let maxLoadN = 0
let lastCycleTimes = { up: 0, down: 0 }

export function recordTelemetry(frame: TelemetryFrame): void {
  if (activeRunId === null || frame.phase === 'idle') return
  pointBuffer.push(frame)
  maxLoadN = Math.max(maxLoadN, frame.loadN)
  if (pointBuffer.length >= 50) flushPoints()
}

export function recordCycle(phase: 'up' | 'down', elapsedSec: number): void {
  lastCycleTimes[phase] = elapsedSec
}

function flushPoints(): void {
  if (activeRunId === null || pointBuffer.length === 0) return
  const points = pointBuffer.map((p) => ({
    tMs: p.tMs,
    loadN: p.loadN,
    heightMm: p.heightMm,
    phase: p.phase
  }))
  pointBuffer = []
  testRunsRepo.addPoints(activeRunId, points)
}

/** Closes the active run. READY means it completed normally. */
export function finishRun(finalStatus: HardwareStatus | 'ABORTED'): void {
  if (activeRunId === null) return
  flushPoints()
  testRunsRepo.finish(activeRunId, {
    upCycleSec: lastCycleTimes.up,
    downCycleSec: lastCycleTimes.down,
    maxLoadN,
    resultStatus: finalStatus === HardwareStatus.READY ? 'COMPLETED' : finalStatus
  })
  activeRunId = null
}

export function getActiveRunId(): number | null {
  return activeRunId
}

function isMoving(status: HardwareStatus): boolean {
  return status === HardwareStatus.PANTO_RAISING || status === HardwareStatus.PANTO_RETRIEVING
}

export async function startRun(request: StartRunRequest): Promise<void> {
  const hardware = getHardware()
  const snapshot = hardware.getSnapshot()

  if (!snapshot.connected) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
  if (snapshot.mode === 'MANUAL') throw new CommandError(ErrorCode.MANUAL_MODE)
  if (FAULT_STATUSES.includes(snapshot.status)) throw new CommandError(ErrorCode.FAULT_ACTIVE)
  if (!snapshot.homed) throw new CommandError(ErrorCode.NOT_HOMED)
  if (isMoving(snapshot.status)) throw new CommandError(ErrorCode.ALREADY_RUNNING)

  const resuming = snapshot.status === HardwareStatus.HALT && activeRunId !== null
  if (resuming) {
    // A paused run always resumes with its own model, whatever the UI now shows.
    const model = snapshot.activeModelId ? modelsRepo.getIncludingArchived(snapshot.activeModelId) : undefined
    if (!model) throw new CommandError(ErrorCode.NO_MODEL)
    await hardware.start(model)
    return
  }

  if (!snapshot.resetSinceLastRun) throw new CommandError(ErrorCode.RESET_REQUIRED)

  const model = modelsRepo.get(request.modelId)
  if (!model) throw new CommandError(ErrorCode.NO_MODEL)
  const partNo = request.partNo.trim()
  if (!partNo) throw new CommandError(ErrorCode.INVALID_INPUT, 'Enter the Part-No before starting a test.')
  if (partNo.length > PART_NO_MAX) {
    throw new CommandError(ErrorCode.INVALID_INPUT, `Part-No must be at most ${PART_NO_MAX} characters.`)
  }
  if (!usersRepo.findById(request.employeeUserId)) {
    throw new CommandError(ErrorCode.INVALID_INPUT, 'Select a valid employee.')
  }

  maxLoadN = 0
  lastCycleTimes = { up: 0, down: 0 }
  pointBuffer = []
  activeRunId = testRunsRepo.create({
    employeeUserId: request.employeeUserId,
    modelId: model.id,
    partNo
  })
  try {
    await hardware.start(model)
  } catch (error) {
    finishRun('ABORTED')
    throw error
  }
}

export async function stopRun(): Promise<void> {
  const hardware = getHardware()
  if (!isMoving(hardware.getSnapshot().status)) throw new CommandError(ErrorCode.NOT_RUNNING)
  await hardware.stop()
}

export async function resetMachine(): Promise<void> {
  const hardware = getHardware()
  if (!hardware.getSnapshot().connected) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
  // Resetting mid-test aborts it; the machine stops where it is.
  if (activeRunId !== null) {
    if (isMoving(hardware.getSnapshot().status)) await hardware.stop()
    finishRun('ABORTED')
  }
  await hardware.reset()
}

export async function homeMachine(): Promise<void> {
  const hardware = getHardware()
  const snapshot = hardware.getSnapshot()
  if (!snapshot.connected) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
  if (FAULT_STATUSES.includes(snapshot.status)) throw new CommandError(ErrorCode.FAULT_ACTIVE)
  if (isMoving(snapshot.status) || snapshot.status === HardwareStatus.HALT) {
    throw new CommandError(ErrorCode.HOMING_BLOCKED)
  }
  await hardware.home()
}

export async function setMachineMode(mode: MachineMode): Promise<void> {
  const hardware = getHardware()
  const snapshot = hardware.getSnapshot()
  if (!snapshot.connected) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
  if (snapshot.mode === mode) return
  if (isMoving(snapshot.status) || snapshot.status === HardwareStatus.HALT) {
    throw new CommandError(
      ErrorCode.INVALID_INPUT,
      'Finish the test or press RESET before changing mode.'
    )
  }
  await hardware.setMode(mode)
}

export async function jogMachine(direction: JogDirection, active: boolean): Promise<void> {
  const hardware = getHardware()
  if (!active) {
    await hardware.jog(direction, false)
    return
  }
  const snapshot = hardware.getSnapshot()
  if (!snapshot.connected) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
  if (snapshot.mode !== 'MANUAL') {
    throw new CommandError(ErrorCode.INVALID_INPUT, 'Switch to MANUAL MODE to jog the pantograph.')
  }
  if (FAULT_STATUSES.includes(snapshot.status)) throw new CommandError(ErrorCode.FAULT_ACTIVE)
  await hardware.jog(direction, true)
}

/** Called on app quit: a run in progress cannot continue without the app. */
export async function abortActiveRun(): Promise<void> {
  if (activeRunId === null) return
  const hardware = getHardware()
  if (isMoving(hardware.getSnapshot().status)) await hardware.stop().catch(() => undefined)
  finishRun('ABORTED')
}
