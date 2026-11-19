import {
  ErrorCode,
  type ConnectionTestResult,
  type HardwareConfig,
  type MachineSettings,
  type ModelConfig,
  type ModelDraft,
  type ModelPoint,
  type SpeedSettings,
  type UserAccount
} from '@shared/types'
import { statusText } from '@shared/types'
import { modelsRepo, settingsRepo, usersRepo } from '../db/repositories'
import { CommandError } from '../errors'
import { log } from '../logger'
import { ConfigError, validateHardwareConfig } from '../hardware/config'
import { buildDriver, getHardware, loadHardwareConfig } from '../hardware/HardwareManager'
import * as auth from './authService'
import { currentModel } from './testService'

export const MODEL_ROWS = 9
const NAME_MAX = 40
const USER_NAME_MAX = 20
const PASSWORD_MIN = 3
const MAX_SPEED_MM_S = 500

function invalid(message: string): CommandError {
  return new CommandError(ErrorCode.INVALID_INPUT, message)
}

// ---------------------------------------------------------------------------
// Models (Settings: MODEL, LOAD / HEIGHT, OK)
// ---------------------------------------------------------------------------

/**
 * Saves the edited model and makes it the current one. A new name adds a
 * new model; the original stays.
 */
export function saveModel(draft: ModelDraft): { models: ModelConfig[]; current: ModelConfig } {
  const name = String(draft.name ?? '').trim()
  if (!name) throw new CommandError(ErrorCode.INVALID_INPUT, 'Model Cannot Be Empty')
  if (name.length > NAME_MAX) throw invalid(`Model name must be at most ${NAME_MAX} characters.`)
  if (!Array.isArray(draft.points) || draft.points.length !== MODEL_ROWS) {
    throw invalid(`A model needs ${MODEL_ROWS} LOAD and HEIGHT values.`)
  }
  const heightCap = Number(settingsRepo.get('height_capacity_mm') ?? 4000)
  const points: ModelPoint[] = draft.points.map((p, i) => {
    const loadN = Number(p.loadN)
    const heightMm = Number(p.heightMm)
    if (!Number.isFinite(loadN) || loadN < 0 || loadN > 1000) throw invalid(`X${i + 1}: enter a load in N.`)
    if (!Number.isFinite(heightMm) || heightMm < 0 || heightMm > heightCap) {
      throw invalid(`Y${i + 1}: enter a height between 0 and ${heightCap} mm.`)
    }
    return { rowIndex: i + 1, loadN, heightMm }
  })
  const distanceMm = points[3].heightMm
  if (distanceMm <= 0) throw invalid('Y4 (the travel distance) must be greater than 0.')

  const editing = draft.id ? modelsRepo.get(draft.id) : undefined
  const sameName = modelsRepo.idByName(name)
  let id: number | undefined
  if (editing && editing.name.toLowerCase() === name.toLowerCase()) id = editing.id
  else if (sameName !== undefined) id = sameName
  id = modelsRepo.save({ id, name, distanceMm, points })
  settingsRepo.set('current_model_id', String(id))
  log.info(`Model "${name}" saved`)
  return { models: modelsRepo.list(), current: modelsRepo.get(id)! }
}

// ---------------------------------------------------------------------------
// Users (Settings: USERNAME / PASSWORD / CHANGE, employee names / SAVE)
// ---------------------------------------------------------------------------

export function saveUserNames(names: string[]): UserAccount[] {
  const users = usersRepo.list()
  if (!Array.isArray(names) || names.length !== users.length) throw invalid('Enter all four names.')
  const cleaned = names.map((n) => String(n ?? '').trim())
  cleaned.forEach((n, i) => {
    if (!n) throw invalid(`Name ${i + 1} cannot be empty.`)
    if (n.length > USER_NAME_MAX) throw invalid(`Names must be at most ${USER_NAME_MAX} characters.`)
  })
  if (new Set(cleaned).size !== cleaned.length) throw new CommandError(ErrorCode.DUPLICATE_NAME, 'Each name must be different.')
  users.forEach((u, i) => usersRepo.rename(u.id, cleaned[i]))
  return usersRepo.list()
}

export function changePassword(id: number, password: string): void {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw invalid(`Password must be at least ${PASSWORD_MIN} characters.`)
  }
  if (!usersRepo.findById(id)) throw invalid('Unknown user.')
  auth.changePassword(id, password)
}

// ---------------------------------------------------------------------------
// Speeds and distance (Settings: JOG / UP / DOWN SPEED, DISTANCE, UPLOAD)
// ---------------------------------------------------------------------------

export function getSettings(): { speeds: SpeedSettings; distanceMm: number } {
  const model = currentModel()
  return { speeds: settingsRepo.getSpeeds(), distanceMm: model?.distanceMm ?? 0 }
}

/**
 * Stores the speeds and distance; the speeds go to the PLC at once and the
 * distance with every START.
 */
export async function upload(input: { speeds: SpeedSettings; distanceMm: number }): Promise<void> {
  const speeds: SpeedSettings = {
    up: Number(input?.speeds?.up),
    down: Number(input?.speeds?.down),
    jog: Number(input?.speeds?.jog)
  }
  for (const [label, value] of Object.entries(speeds)) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_SPEED_MM_S) {
      throw invalid(`${label.toUpperCase()} SPEED must be between 0 and ${MAX_SPEED_MM_S} mm/s.`)
    }
  }
  const distanceMm = Number(input?.distanceMm)
  const heightCap = Number(settingsRepo.get('height_capacity_mm') ?? 4000)
  if (!Number.isFinite(distanceMm) || distanceMm <= 0 || distanceMm > heightCap) {
    throw invalid(`DISTANCE must be between 0 and ${heightCap} mm.`)
  }
  settingsRepo.setSpeeds(speeds)
  const model = currentModel()
  if (model && model.distanceMm !== distanceMm) modelsRepo.save({ ...model, distanceMm })
  const hardware = getHardware()
  if (hardware.getState().connected) await hardware.writeSpeeds(speeds)
}

// ---------------------------------------------------------------------------
// Machine and company
// ---------------------------------------------------------------------------

export function getMachineSettings(): MachineSettings {
  const s = settingsRepo.getAll()
  return {
    machineId: s.machine_id ?? '',
    loadCapacityKg: Number(s.load_capacity_kg ?? 50),
    heightCapacityMm: Number(s.height_capacity_mm ?? 4000),
    company: {
      name: s.company_name ?? '',
      addressLine1: s.company_address_1 ?? '',
      addressLine2: s.company_address_2 ?? ''
    },
    measurementSpeedText: s.measurement_speed_text ?? ''
  }
}

export async function setMachineSettings(input: MachineSettings): Promise<MachineSettings> {
  const machineId = String(input?.machineId ?? '').trim()
  const name = String(input?.company?.name ?? '').trim()
  const a1 = String(input?.company?.addressLine1 ?? '').trim()
  const a2 = String(input?.company?.addressLine2 ?? '').trim()
  const speedText = String(input?.measurementSpeedText ?? '').trim()
  if (!machineId || machineId.length > NAME_MAX) throw invalid(`MACHINE ID is required (max ${NAME_MAX} characters).`)
  if (name.length > 80) throw invalid('Company name must be at most 80 characters.')
  if (a1.length > 80 || a2.length > 80) throw invalid('Address lines must be at most 80 characters.')
  if (speedText.length > 20) throw invalid('Speed text must be at most 20 characters.')
  const loadKg = Number(input?.loadCapacityKg)
  const heightMm = Number(input?.heightCapacityMm)
  if (!Number.isFinite(loadKg) || loadKg <= 0 || loadKg > 10000) throw invalid('Load capacity must be a positive number of kg.')
  if (!Number.isFinite(heightMm) || heightMm <= 0 || heightMm > 20000) {
    throw invalid('Height capacity must be a positive number of mm.')
  }
  settingsRepo.set('machine_id', machineId)
  settingsRepo.set('load_capacity_kg', String(loadKg))
  settingsRepo.set('height_capacity_mm', String(heightMm))
  settingsRepo.set('company_name', name)
  settingsRepo.set('company_address_1', a1)
  settingsRepo.set('company_address_2', a2)
  settingsRepo.set('measurement_speed_text', speedText)
  // The controller enforces these limits itself.
  await getHardware().refreshLimits().catch((error) => log.warn('Could not send limits to the controller', error))
  return getMachineSettings()
}

// ---------------------------------------------------------------------------
// Hardware driver configuration
// ---------------------------------------------------------------------------

function parseHardwareConfig(input: unknown): HardwareConfig {
  try {
    return validateHardwareConfig(input)
  } catch (error) {
    if (error instanceof ConfigError) throw invalid(error.message)
    throw error
  }
}

export function getHardwareConfig(): HardwareConfig {
  return loadHardwareConfig()
}

/** Persists the config and switches the live driver to it. */
export async function setHardwareConfig(input: unknown): Promise<HardwareConfig> {
  const config = parseHardwareConfig(input)
  settingsRepo.set('hardware_config', JSON.stringify(config))
  log.info(`Hardware driver set to ${config.driver}`)
  await getHardware().setDriver(buildDriver(config), config.driver)
  return config
}

/**
 * Tries the given (possibly unsaved) config and reports a live reading. The
 * active driver is released first when it uses the same link (a COM port
 * cannot be opened twice); the supervisor reconnects it afterwards.
 */
export async function testHardwareConfig(input: unknown): Promise<ConnectionTestResult> {
  const config = parseHardwareConfig(input)
  if (config.driver === 'simulator') throw invalid('Choose a machine connection to test.')
  const hub = getHardware()
  // A COM port cannot be opened twice: the controller and Modbus drivers may share one.
  const serialKinds = ['controller', 'modbus']
  const releasedLive =
    hub.driverKind === config.driver || (serialKinds.includes(hub.driverKind) && serialKinds.includes(config.driver))
  if (releasedLive) await hub.disconnect()
  const probe = buildDriver(config, { probeOnly: true })
  try {
    await probe.connect()
    const state = probe.getState()
    return { status: statusText(state) || `code ${state.code}`, loadN: state.loadN, positionMm: state.positionMm }
  } finally {
    await probe.disconnect().catch(() => undefined)
    if (releasedLive) void hub.tryConnect()
  }
}

export function describeDevice(config: HardwareConfig): string {
  if (config.driver === 's7') return `${config.s7.connection.host}:${config.s7.connection.port}`
  if (config.driver === 'modbus' || config.driver === 'controller') {
    const c = config[config.driver].connection
    return c.transport === 'rtu-serial' ? c.serialPath : `${c.host}:${c.port}`
  }
  return 'SIMULATOR'
}
