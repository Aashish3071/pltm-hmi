import {
  ErrorCode,
  StatusCode,
  type GraphHistory,
  type MachineEvent,
  type ModelConfig,
  type PlcState,
  type Sample,
  type Selection
} from '@shared/types'
import { computeResults } from '@shared/analysis'
import { getHardware } from '../hardware/HardwareManager'
import type { FaultKind } from '../hardware/HardwareInterface'
import { modelsRepo, settingsRepo, testRunsRepo } from '../db/repositories'
import { CommandError } from '../errors'
import { log } from '../logger'
import { currentUser } from './authService'

/**
 * Test bookkeeping:
 * - START sets the PLC's start bit and turns recording on ("upload = 1");
 *   every poll is then appended to the current test, n.
 * - CYCLE COMPLETED (91) turns recording off and the results are computed.
 * - RESET moves n to n-1 and n-1 to n-2,
 *   so the graph can overlay the last three tests.
 */

const FLUSH_EVERY = 200

let recording = false
let historyVersion = 1
/** Test run ids for n, n-1, n-2 (null = empty). */
let historyIds: (number | null)[] = [null, null, null]
let history: Sample[][] = [[], [], []]
let pending: Sample[] = []
let storedCount = 0
let partNo = '#####'

export function initTestService(): void {
  try {
    const ids = JSON.parse(settingsRepo.get('graph_history') ?? '[]') as (number | null)[]
    historyIds = [0, 1, 2].map((i) => (typeof ids[i] === 'number' ? ids[i] : null))
  } catch {
    historyIds = [null, null, null]
  }
  history = historyIds.map((id) => (id ? testRunsRepo.samples(id) : []))
  storedCount = history[0].length
}

function saveHistoryIds(): void {
  settingsRepo.set('graph_history', JSON.stringify(historyIds))
  historyVersion++
}

export function getHistory(): GraphHistory {
  return { version: historyVersion, n: history[0], n1: history[1], n2: history[2] }
}

// ---------------------------------------------------------------------------
// Selection (Home screen OK button)
// ---------------------------------------------------------------------------

export function currentModel(): ModelConfig | undefined {
  const id = Number(settingsRepo.get('current_model_id') ?? 0)
  return (id && modelsRepo.get(id)) || modelsRepo.list()[0]
}

export function getSelection(): Selection {
  const model = currentModel()
  return { modelId: model?.id ?? 0, modelName: model?.name ?? '', partNo }
}

/** OK on Home: remember the model; an empty Part-No becomes "#####". */
export function select(modelId: number, part: string): Selection {
  const model = modelsRepo.get(modelId)
  if (!model) throw new CommandError(ErrorCode.NO_MODEL)
  settingsRepo.set('current_model_id', String(model.id))
  partNo = String(part ?? '').trim() || '#####'
  return getSelection()
}

// ---------------------------------------------------------------------------
// Polls
// ---------------------------------------------------------------------------

/** Called for every PLC poll; returns what the renderer is told. */
export function onState(state: PlcState): MachineEvent {
  let recorded = false
  if (recording && state.connected) {
    const sample: Sample = { loadN: state.loadN, positionMm: state.positionMm, code: state.code }
    history[0].push(sample)
    pending.push(sample)
    recorded = true
    if (pending.length >= FLUSH_EVERY) flush()
    if (state.code === StatusCode.CYCLE_COMPLETED) {
      recording = false
      finishCurrent('COMPLETED', state)
    }
  }
  return { state, recorded, historyVersion }
}

function flush(): void {
  const id = historyIds[0]
  if (!id || pending.length === 0) return
  testRunsRepo.addSamples(id, storedCount, pending)
  storedCount += pending.length
  pending = []
}

function finishCurrent(status: string, state?: PlcState): void {
  const id = historyIds[0]
  if (!id) return
  flush()
  const run = testRunsRepo.get(id)
  const model = run?.modelId ? modelsRepo.get(run.modelId) : undefined
  testRunsRepo.finish(id, {
    upTimeSec: state?.upTimeSec ?? 0,
    downTimeSec: state?.downTimeSec ?? 0,
    status,
    results: computeResults(history[0], model ?? null)
  })
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function requireConnected(): void {
  if (!getHardware().getState().connected) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
}

export async function start(): Promise<void> {
  requireConnected()
  const model = currentModel()
  if (!model) throw new CommandError(ErrorCode.NO_MODEL)
  if (!historyIds[0]) {
    historyIds[0] = testRunsRepo.create({
      employeeUserId: currentUser()?.id ?? null,
      modelId: model.id,
      partNo
    })
    history[0] = []
    storedCount = 0
    pending = []
    saveHistoryIds()
  }
  await getHardware().start(model)
  recording = true
}

export async function stop(): Promise<void> {
  requireConnected()
  await getHardware().stop()
}

export async function reset(): Promise<void> {
  requireConnected()
  if (historyIds[0]) {
    if (recording) finishCurrent('RESET')
    else flush()
  }
  recording = false
  pending = []
  storedCount = 0
  historyIds = [null, historyIds[0], historyIds[1]]
  history = [[], history[0], history[1]]
  saveHistoryIds()
  await getHardware().reset()
}

export async function home(): Promise<void> {
  requireConnected()
  await getHardware().home()
}

export async function forceFault(kind: FaultKind): Promise<void> {
  await getHardware().forceFault(kind)
}

/** The test the REPORT button reports on (n). */
export function currentTest(): { runId: number; samples: Sample[] } | null {
  const id = historyIds[0]
  if (!id || history[0].length === 0) return null
  flush()
  return { runId: id, samples: history[0] }
}

/** On quit: a test still recording cannot continue without the app. */
export function shutdown(): void {
  try {
    if (recording) finishCurrent('ABORTED')
    else flush()
  } catch (error) {
    log.error('Could not save the current test on exit', error)
  }
  recording = false
}
