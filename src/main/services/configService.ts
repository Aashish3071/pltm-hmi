import {
  ErrorCode,
  MAX_SPEED_MM_S,
  type HardwareConfig,
  type MachineSettings,
  type ModelConfig,
  type ModelPoint,
  type SpeedSettings,
  type UserAccount
} from '@shared/types'
import { modelsRepo, settingsRepo, usersRepo } from '../db/repositories'
import { CommandError } from '../errors'
import { log } from '../logger'
import {
  ConfigError,
  missingSafetySignals,
  validateConnection,
  validateDriver,
  validateRegisterMap
} from '../hardware/config'
import { buildDriver, getHardware, loadHardwareConfig } from '../hardware/HardwareManager'
import { getActiveRunId } from './testRunService'
import * as auth from './authService'

export const MODEL_ROWS = 9
const NAME_MAX = 40
const USER_NAME_MAX = 20
const PASSWORD_MIN = 4

function invalid(message: string): CommandError {
  return new CommandError(ErrorCode.INVALID_INPUT, message)
}

function capacities(): { loadN: number; heightMm: number } {
  const s = settingsRepo.getAll()
  return {
    loadN: Number(s.load_capacity_n ?? 250),
    heightMm: Number(s.height_capacity_mm ?? 4000)
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export function saveModel(input: Omit<ModelConfig, 'id'> & { id?: number }): ModelConfig[] {
  const name = String(input.name ?? '').trim()
  if (!name) throw invalid('Model name is required.')
  if (name.length > NAME_MAX) throw invalid(`Model name must be at most ${NAME_MAX} characters.`)

  if (!Array.isArray(input.points) || input.points.length !== MODEL_ROWS) {
    throw invalid(`A model needs exactly ${MODEL_ROWS} load/height rows.`)
  }
  const cap = capacities()
  const points: ModelPoint[] = input.points.map((p, i) => {
    const loadN = Number(p.loadN)
    const heightMm = Number(p.heightMm)
    const row = i + 1
    if (!Number.isFinite(loadN) || loadN < 0 || loadN > cap.loadN) {
      throw invalid(`Row ${row}: load must be between 0 and ${cap.loadN} N.`)
    }
    if (!Number.isFinite(heightMm) || heightMm < 0 || heightMm > cap.heightMm) {
      throw invalid(`Row ${row}: height must be between 0 and ${cap.heightMm} mm.`)
    }
    return { rowIndex: row, loadN, heightMm }
  })

  // Per the machine manual, row 4's height is the distance the pantograph travels.
  const distanceMm = points[3].heightMm
  if (distanceMm <= 0) throw invalid('Row 4 height (travel distance) must be greater than 0.')

  const existingId = modelsRepo.idByName(name)
  if (existingId !== undefined && existingId !== input.id) {
    throw new CommandError(ErrorCode.DUPLICATE_NAME, `A model named "${name}" already exists.`)
  }
  if (input.id !== undefined && !modelsRepo.get(input.id)) {
    throw invalid('That model no longer exists.')
  }
  if (input.id !== undefined && isActiveRunModel(input.id)) {
    throw invalid('This model is being used by the current test. Finish or RESET it first.')
  }

  modelsRepo.save({ id: input.id, name, distanceMm, points })
  return modelsRepo.list()
}

export function deleteModel(id: number): ModelConfig[] {
  if (!modelsRepo.get(id)) throw invalid('That model no longer exists.')
  if (modelsRepo.list().length <= 1) throw invalid('At least one model must remain.')
  if (isActiveRunModel(id)) {
    throw invalid('This model is being used by the current test. Finish or RESET it first.')
  }
  modelsRepo.archive(id)
  return modelsRepo.list()
}

function isActiveRunModel(id: number): boolean {
  return getActiveRunId() !== null && getHardware().getSnapshot().activeModelId === id
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function renameUser(id: number, displayName: string): UserAccount[] {
  const name = String(displayName ?? '').trim()
  if (!name) throw invalid('User name cannot be empty.')
  if (name.length > USER_NAME_MAX) throw invalid(`User name must be at most ${USER_NAME_MAX} characters.`)
  const users = usersRepo.list()
  if (!users.some((u) => u.id === id)) throw invalid('Unknown user.')
  // Login matches either the display name or the fixed slot name, so both must be unique.
  const clash = users.find(
    (u) =>
      u.id !== id &&
      (u.displayName.toLowerCase() === name.toLowerCase() || u.slot.toLowerCase() === name.toLowerCase())
  )
  if (clash) throw new CommandError(ErrorCode.DUPLICATE_NAME, `"${name}" is already used by another user.`)
  usersRepo.rename(id, name)
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
// Machine settings
// ---------------------------------------------------------------------------

export async function setSpeeds(input: SpeedSettings): Promise<SpeedSettings> {
  const speeds: SpeedSettings = {
    up: Number(input.up),
    down: Number(input.down),
    jog: Number(input.jog)
  }
  for (const [label, value] of Object.entries(speeds)) {
    if (!Number.isFinite(value) || value <= 0 || value > MAX_SPEED_MM_S) {
      throw invalid(`${label.toUpperCase()} SPEED must be between 0 and ${MAX_SPEED_MM_S} mm/s.`)
    }
  }
  settingsRepo.setSpeeds(speeds)
  await getHardware().setSpeeds(speeds)
  return speeds
}

export function getMachineSettings(): MachineSettings {
  const s = settingsRepo.getAll()
  return {
    machineId: s.machine_id ?? '',
    loadCapacityN: Number(s.load_capacity_n ?? 250),
    heightCapacityMm: Number(s.height_capacity_mm ?? 4000),
    companyName: s.company_name ?? '',
    companyAddress: s.company_address ?? ''
  }
}

export async function setMachineSettings(input: MachineSettings): Promise<MachineSettings> {
  const machineId = String(input.machineId ?? '').trim()
  const companyName = String(input.companyName ?? '').trim()
  const companyAddress = String(input.companyAddress ?? '').trim()
  if (!companyName || companyName.length > 80) {
    throw invalid('Company name is required (max 80 characters); it is printed on certificates.')
  }
  if (companyAddress.length > 200) throw invalid('Company address must be at most 200 characters.')
  const loadCapacityN = Number(input.loadCapacityN)
  const heightCapacityMm = Number(input.heightCapacityMm)
  if (!machineId || machineId.length > NAME_MAX) {
    throw invalid(`Machine ID is required (max ${NAME_MAX} characters).`)
  }
  if (!Number.isFinite(loadCapacityN) || loadCapacityN <= 0 || loadCapacityN > 100000) {
    throw invalid('Load capacity must be a positive number of newtons.')
  }
  if (!Number.isFinite(heightCapacityMm) || heightCapacityMm <= 0 || heightCapacityMm > 20000) {
    throw invalid('Height capacity must be a positive number of millimetres.')
  }
  const tooTall = modelsRepo.list().find((m) => m.points.some((p) => p.heightMm > heightCapacityMm))
  if (tooTall) {
    throw invalid(`Model "${tooTall.name}" uses heights above ${heightCapacityMm} mm. Edit it first.`)
  }
  settingsRepo.set('machine_id', machineId)
  settingsRepo.set('load_capacity_n', String(loadCapacityN))
  settingsRepo.set('height_capacity_mm', String(heightCapacityMm))
  settingsRepo.set('company_name', companyName)
  settingsRepo.set('company_address', companyAddress)
  const hardware = getHardware()
  // On the real machine these become the PLC's own overload and travel limits.
  await hardware.setLoadCapacity(loadCapacityN)
  await hardware.setHeightCapacity(heightCapacityMm)
  return getMachineSettings()
}

// ---------------------------------------------------------------------------
// Hardware driver configuration
// ---------------------------------------------------------------------------

function parseHardwareConfig(input: unknown): HardwareConfig {
  try {
    const raw = input as Partial<HardwareConfig>
    return {
      driver: validateDriver(raw?.driver),
      connection: validateConnection(raw?.connection),
      registerMap: validateRegisterMap(raw?.registerMap)
    }
  } catch (error) {
    if (error instanceof ConfigError) throw invalid(error.message)
    throw error
  }
}

function assertIdle(): void {
  if (getActiveRunId() !== null) {
    throw invalid('Finish or RESET the current test before changing the machine connection.')
  }
}

export function getHardwareConfig(): HardwareConfig {
  return loadHardwareConfig()
}

/** Persists the config and switches the live driver to it. */
export async function setHardwareConfig(input: unknown): Promise<HardwareConfig> {
  const config = parseHardwareConfig(input)
  assertIdle()
  settingsRepo.set('hardware_driver', config.driver)
  settingsRepo.set('modbus_connection', JSON.stringify(config.connection))
  settingsRepo.set('modbus_register_map', JSON.stringify(config.registerMap, null, 2))
  log.info(`Hardware driver set to ${config.driver}`)
  const missing = config.driver === 'modbus' ? missingSafetySignals(config.registerMap) : []
  if (missing.length) log.warn(`Register map does not connect: ${missing.join('; ')}`)
  await getHardware().setDriver(buildDriver(config), config.driver)
  return config
}

/**
 * Tries the given (possibly unsaved) config and reports a live reading. The
 * active driver is released first, since a COM port cannot be opened twice;
 * the supervisor reconnects it afterwards.
 */
export async function testHardwareConfig(
  input: unknown
): Promise<{ status: string; loadN: number; heightMm: number }> {
  const config = parseHardwareConfig({ ...(input as object), driver: 'modbus' })
  assertIdle()
  const hub = getHardware()
  const releasedLive = hub.driverKind === 'modbus'
  if (releasedLive) await hub.disconnect()
  const probe = buildDriver(config, { probeOnly: true })
  try {
    await probe.connect()
    const snapshot = probe.getSnapshot()
    return { status: snapshot.status, loadN: snapshot.loadN, heightMm: snapshot.heightMm }
  } finally {
    await probe.disconnect().catch(() => undefined)
    if (releasedLive) void hub.tryConnect()
  }
}
