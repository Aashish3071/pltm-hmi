import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { SerialPort } from 'serialport'
import {
  ErrorCode,
  ERROR_MESSAGES,
  HardwareStatus,
  IPC,
  type IpcResult,
  type JogDirection,
  type MachineMode,
  type CalibrationDraft,
  type CalibrationPolicy,
  type CertificateDraft,
  type MachineSettings,
  type ModelConfig,
  type SerialPortInfo,
  type SpeedSettings,
  type StartRunRequest,
  type SystemInfo
} from '@shared/types'
import { getHardware, loadHardwareConfig } from '../hardware/HardwareManager'
import type { FaultKind } from '../hardware/HardwareInterface'
import {
  calibrationsRepo,
  modelsRepo,
  settingsRepo,
  testRunsRepo,
  usersRepo
} from '../db/repositories'
import { CommandError } from '../errors'
import { log, logPath } from '../logger'
import * as auth from '../services/authService'
import * as calibration from '../services/calibrationService'
import * as config from '../services/configService'
import { generateReportFiles, reportDir, runChartData } from '../services/reportService'
import {
  finishRun,
  getActiveRunId,
  homeMachine,
  jogMachine,
  resetMachine,
  setMachineMode,
  startRun,
  stopRun
} from '../services/testRunService'

type Access = 'public' | 'user' | 'admin'

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

function fail(code: ErrorCode, message?: string): IpcResult<never> {
  return { ok: false, code, message: message ?? ERROR_MESSAGES[code] }
}

/**
 * Registers an invoke handler. Expected failures (CommandError) become typed
 * results; anything else is logged and reported generically, so the renderer
 * never sees a raw rejection.
 */
function handle<T>(
  channel: string,
  access: Access,
  fn: (...args: never[]) => Promise<T> | T
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      if (access === 'user') auth.requireUser()
      if (access === 'admin') auth.requireAdmin()
      return ok(await fn(...(args as never[])))
    } catch (error) {
      if (error instanceof CommandError) return fail(error.code, error.message)
      log.error(`IPC ${channel} failed`, error)
      return fail(ErrorCode.INTERNAL, `${ERROR_MESSAGES[ErrorCode.INTERNAL]} (${logPath()})`)
    }
  })
}

function deviceAddress(): string {
  const { driver, connection: c } = loadHardwareConfig()
  if (driver === 'simulator') return 'SIMULATOR'
  return c.transport === 'rtu-serial' ? `${c.serialPath} @ ${c.baudRate}` : `${c.host}:${c.port}`
}

export function registerIpcHandlers(): void {
  handle(IPC.APP_QUIT, 'public', () => {
    app.quit()
  })

  handle(IPC.APP_SYSTEM_INFO, 'public', (): SystemInfo => {
    const s = settingsRepo.getAll()
    return {
      machineId: s.machine_id ?? '-',
      deviceIp: deviceAddress(),
      loadCapacityN: Number(s.load_capacity_n ?? 0),
      heightCapacityMm: Number(s.height_capacity_mm ?? 0),
      appVersion: app.getVersion(),
      driver: getHardware().driverKind
    }
  })

  // --- auth ---------------------------------------------------------------
  handle(IPC.AUTH_LOGIN, 'public', (credentials: { username: string; password: string }) => {
    const user = auth.login(credentials?.username, credentials?.password)
    if (!user) {
      log.warn(`Failed login for "${String(credentials?.username ?? '')}"`)
      throw new CommandError(ErrorCode.INVALID_CREDENTIALS)
    }
    auth.startSession(user)
    log.info(`Login: ${user.displayName}`)
    return user
  })
  handle(IPC.AUTH_LOGOUT, 'public', () => {
    auth.endSession()
    return true
  })
  handle(IPC.AUTH_ADMIN_CHECK, 'user', (password: string) => {
    if (!auth.unlockAdmin(password)) throw new CommandError(ErrorCode.INVALID_CREDENTIALS)
    return true
  })
  handle(IPC.AUTH_ADMIN_LOCK, 'public', () => {
    auth.lockAdmin()
    return true
  })

  // --- users --------------------------------------------------------------
  // The login screen does not list users, so listing needs a session.
  handle(IPC.USERS_LIST, 'user', () => usersRepo.list())
  handle(IPC.USERS_RENAME, 'admin', (input: { id: number; displayName: string }) =>
    config.renameUser(input.id, input.displayName)
  )
  handle(IPC.USERS_CHANGE_PASSWORD, 'admin', (input: { id: number; password: string }) => {
    config.changePassword(input.id, input.password)
    return true
  })

  // --- models -------------------------------------------------------------
  handle(IPC.MODELS_LIST, 'user', () => modelsRepo.list())
  handle(IPC.MODELS_SAVE, 'admin', (model: Omit<ModelConfig, 'id'> & { id?: number }) =>
    config.saveModel(model)
  )
  handle(IPC.MODELS_DELETE, 'admin', (id: number) => config.deleteModel(id))

  // --- settings -----------------------------------------------------------
  handle(IPC.SETTINGS_GET_ALL, 'user', () => {
    const { modbus_register_map: _map, modbus_connection: _conn, ...rest } = settingsRepo.getAll()
    return { ...rest, resolved_report_dir: reportDir() }
  })
  handle(IPC.SETTINGS_SET_SPEEDS, 'admin', (speeds: SpeedSettings) => config.setSpeeds(speeds))
  handle(IPC.SETTINGS_SET_REPORT_DIR, 'admin', (dir: string) => {
    settingsRepo.set('report_output_dir', String(dir ?? ''))
    return reportDir()
  })
  handle(IPC.SETTINGS_PICK_REPORT_DIR, 'admin', async () => {
    const window = BrowserWindow.getFocusedWindow()
    const options = { properties: ['openDirectory', 'createDirectory'] as const, defaultPath: reportDir() }
    const result = window
      ? await dialog.showOpenDialog(window, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] })
    if (result.canceled || result.filePaths.length === 0) return reportDir()
    settingsRepo.set('report_output_dir', result.filePaths[0])
    return reportDir()
  })
  handle(IPC.SETTINGS_SET_MACHINE, 'admin', (input: MachineSettings) =>
    config.setMachineSettings(input)
  )

  // --- hardware configuration --------------------------------------------
  handle(IPC.HARDWARE_GET_CONFIG, 'admin', () => config.getHardwareConfig())
  handle(IPC.HARDWARE_SET_CONFIG, 'admin', (input: unknown) => config.setHardwareConfig(input))
  handle(IPC.HARDWARE_TEST_CONNECTION, 'admin', (input: unknown) => config.testHardwareConfig(input))
  handle(IPC.HARDWARE_LIST_PORTS, 'admin', async (): Promise<SerialPortInfo[]> => {
    const ports = await SerialPort.list()
    return ports
      .map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        vendorId: p.vendorId,
        productId: p.productId,
        chip: chipName(p.vendorId)
      }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  })
  handle(IPC.HARDWARE_RECONNECT, 'user', async () => {
    const connected = await getHardware().tryConnect()
    if (!connected) {
      throw new CommandError(ErrorCode.CONNECTION_FAILED, getHardware().connectError || undefined)
    }
    return true
  })

  // --- machine ------------------------------------------------------------
  handle(IPC.MACHINE_SNAPSHOT, 'public', () => getHardware().getSnapshot())
  handle(IPC.MACHINE_START, 'user', (request: StartRunRequest) => startRun(request))
  handle(IPC.MACHINE_STOP, 'user', () => stopRun())
  handle(IPC.MACHINE_RESET, 'user', () => resetMachine())
  handle(IPC.MACHINE_HOME, 'user', () => homeMachine())
  handle(IPC.MACHINE_SET_MODE, 'user', (mode: MachineMode) => setMachineMode(mode))
  handle(IPC.MACHINE_JOG, 'user', (input: { direction: JogDirection; active: boolean }) =>
    jogMachine(input.direction, input.active)
  )
  handle(IPC.MACHINE_FORCE_FAULT, 'admin', async (kind: FaultKind) => {
    const hardware = getHardware()
    if (!hardware.supportsFaultSimulation) {
      throw new CommandError(ErrorCode.INVALID_INPUT, 'Fault simulation is only available on the simulator.')
    }
    await hardware.forceFault(kind)
  })

  // --- reports ------------------------------------------------------------
  handle(IPC.REPORTS_LAST_RUN, 'user', () => testRunsRepo.lastCompleted() ?? null)
  handle(IPC.REPORTS_RUN_POINTS, 'user', () => {
    const run = testRunsRepo.lastCompleted()
    if (!run) throw new CommandError(ErrorCode.NO_COMPLETED_RUN)
    return runChartData(run.id)
  })
  handle(IPC.REPORTS_GENERATE, 'user', async (input: { chartPng?: string }) => {
    const run = testRunsRepo.lastCompleted()
    if (!run) throw new CommandError(ErrorCode.NO_COMPLETED_RUN)
    return generateReportFiles(run.id, input?.chartPng)
  })
  handle(IPC.REPORTS_OPEN_FOLDER, 'user', async () => {
    const run = testRunsRepo.lastCompleted()
    if (run?.reportPath) shell.showItemInFolder(run.reportPath)
    else await shell.openPath(reportDir())
    return true
  })

  // --- calibration ---------------------------------------------------------
  handle(IPC.CAL_STATUS, 'user', () => calibration.getStatus())
  handle(IPC.CAL_HISTORY, 'admin', () => calibrationsRepo.history())
  handle(IPC.CAL_CAPTURE, 'admin', (input: { durationMs?: number }) =>
    calibration.capture(input?.durationMs)
  )
  handle(IPC.CAL_SAVE, 'admin', (draft: CalibrationDraft) =>
    calibration.save(draft, auth.currentUser()?.displayName ?? 'unknown')
  )
  handle(IPC.CAL_SET_POLICY, 'admin', (policy: CalibrationPolicy) => calibration.setPolicy(policy))
  handle(IPC.CAL_SIMULATE_LOAD, 'admin', (loadN: number | null) => {
    const value = loadN === null || loadN === undefined ? null : Number(loadN)
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100000)) {
      throw new CommandError(ErrorCode.INVALID_INPUT, 'Enter a load of 0 N or more.')
    }
    if (!getHardware().setSimulatedReferenceLoad(value)) {
      throw new CommandError(ErrorCode.INVALID_INPUT, 'Simulated loads are only available on the simulator.')
    }
    return true
  })
  handle(IPC.CERT_SAVE, 'admin', (draft: CertificateDraft) => calibration.saveCertificate(draft))
  handle(IPC.CERT_ATTACH, 'admin', async () => {
    const window = BrowserWindow.getFocusedWindow()
    const options = {
      properties: ['openFile'] as ('openFile')[],
      filters: [{ name: 'Certificate', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return calibration.getStatus()
    return calibration.attachCertificateFile(result.filePaths[0])
  })
  handle(IPC.CERT_OPEN, 'user', async () => {
    const error = await shell.openPath(calibration.certificateFilePath())
    if (error) throw new CommandError(ErrorCode.INVALID_INPUT, `Could not open the certificate: ${error}`)
    return true
  })
}

/** USB-to-serial adapter families by USB vendor id. */
function chipName(vendorId: string | undefined): string | undefined {
  switch ((vendorId ?? '').toLowerCase()) {
    case '0403':
      return 'FTDI'
    case '1a86':
      return 'CH340'
    case '10c4':
      return 'CP210x'
    case '067b':
      return 'Prolific'
    default:
      return undefined
  }
}

/** Fan hardware events out to every renderer window. */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

const TERMINAL_STATUSES: HardwareStatus[] = [
  HardwareStatus.READY,
  HardwareStatus.OVERLOAD,
  HardwareStatus.EMERGENCY_PRESSED,
  HardwareStatus.SERVO_ERROR,
  HardwareStatus.SERVO_OFF,
  HardwareStatus.OVER_TRAVEL,
  HardwareStatus.DISCONNECTED
]

export function onRunStatusChange(status: HardwareStatus): void {
  if (TERMINAL_STATUSES.includes(status) && getActiveRunId() !== null) {
    log.info(`Run ${getActiveRunId()} ended with ${status}`)
    finishRun(status)
  }
}
