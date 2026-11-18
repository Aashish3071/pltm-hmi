import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import pkg from '../../../package.json'
import { SerialPort } from 'serialport'
import {
  ErrorCode,
  ERROR_MESSAGES,
  IPC,
  type IpcResult,
  type MachineSettings,
  type ModelDraft,
  type SerialPortInfo,
  type SpeedSettings,
  type SystemInfo
} from '@shared/types'
import { getHardware, loadHardwareConfig } from '../hardware/HardwareManager'
import type { FaultKind } from '../hardware/HardwareInterface'
import { modelsRepo, settingsRepo, usersRepo } from '../db/repositories'
import { CommandError } from '../errors'
import { log, logPath } from '../logger'
import * as auth from '../services/authService'
import * as config from '../services/configService'
import { generateReport, reportDir } from '../services/reportService'
import * as tests from '../services/testService'

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
function handle<T>(channel: string, access: Access, fn: (...args: never[]) => Promise<T> | T): void {
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

export function registerIpcHandlers(): void {
  // --- app ------------------------------------------------------------------
  handle(IPC.APP_QUIT, 'public', () => {
    setTimeout(() => app.quit(), 50)
    return true
  })
  handle(IPC.APP_SYSTEM_INFO, 'public', (): SystemInfo => {
    const machine = config.getMachineSettings()
    const hw = loadHardwareConfig()
    return {
      machineId: machine.machineId,
      deviceIp: config.describeDevice(hw),
      loadCapacityKg: machine.loadCapacityKg,
      heightCapacityMm: machine.heightCapacityMm,
      appVersion: pkg.version,
      driver: getHardware().driverKind
    }
  })

  // --- auth -----------------------------------------------------------------
  handle(IPC.AUTH_LOGIN, 'public', (input: { username: string; password: string }) => {
    const user = auth.login(input?.username, input?.password)
    if (!user) throw new CommandError(ErrorCode.INVALID_CREDENTIALS)
    auth.startSession(user)
    log.info(`Login: ${user.displayName}`)
    return user
  })
  handle(IPC.AUTH_LOGOUT, 'public', () => {
    auth.endSession()
    return true
  })
  handle(IPC.AUTH_ADMIN_CHECK, 'user', (input: { username: string; password: string }) => {
    if (!auth.unlockAdmin(input?.username, input?.password)) throw new CommandError(ErrorCode.INVALID_CREDENTIALS)
    return true
  })
  handle(IPC.AUTH_ADMIN_LOCK, 'user', () => {
    auth.lockAdmin()
    return true
  })

  // --- users ----------------------------------------------------------------
  handle(IPC.USERS_LIST, 'user', () => usersRepo.list())
  handle(IPC.USERS_SAVE_NAMES, 'admin', (names: string[]) => config.saveUserNames(names))
  handle(IPC.USERS_CHANGE_PASSWORD, 'admin', (input: { id: number; password: string }) => {
    config.changePassword(Number(input?.id), input?.password)
    return true
  })

  // --- models ---------------------------------------------------------------
  handle(IPC.MODELS_LIST, 'user', () => modelsRepo.list())
  handle(IPC.MODELS_SAVE, 'admin', (draft: ModelDraft) => config.saveModel(draft))

  // --- settings -------------------------------------------------------------
  handle(IPC.SETTINGS_GET, 'user', () => ({
    ...config.getSettings(),
    machine: config.getMachineSettings(),
    reportDir: reportDir()
  }))
  handle(IPC.SETTINGS_UPLOAD, 'admin', (input: { speeds: SpeedSettings; distanceMm: number }) => config.upload(input))
  handle(IPC.SETTINGS_SET_MACHINE, 'admin', (input: MachineSettings) => config.setMachineSettings(input))
  handle(IPC.SETTINGS_SET_REPORT_DIR, 'admin', (dir: string) => {
    settingsRepo.set('report_output_dir', String(dir ?? '').trim())
    return reportDir()
  })
  handle(IPC.SETTINGS_PICK_REPORT_DIR, 'admin', async () => {
    const window = BrowserWindow.getFocusedWindow()
    const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (!result.canceled && result.filePaths[0]) settingsRepo.set('report_output_dir', result.filePaths[0])
    return reportDir()
  })

  // --- hardware -------------------------------------------------------------
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
    if (!connected) throw new CommandError(ErrorCode.CONNECTION_FAILED, getHardware().connectError || undefined)
    return true
  })

  // --- machine --------------------------------------------------------------
  handle(IPC.MACHINE_STATE, 'public', () => getHardware().getState())
  handle(IPC.MACHINE_SELECTION, 'user', () => tests.getSelection())
  handle(IPC.MACHINE_SELECT, 'user', (input: { modelId: number; partNo: string }) =>
    tests.select(Number(input?.modelId), input?.partNo)
  )
  handle(IPC.MACHINE_HISTORY, 'user', () => tests.getHistory())
  handle(IPC.MACHINE_START, 'user', () => tests.start())
  handle(IPC.MACHINE_STOP, 'user', () => tests.stop())
  handle(IPC.MACHINE_RESET, 'user', () => tests.reset())
  handle(IPC.MACHINE_HOME, 'user', () => tests.home())
  handle(IPC.MACHINE_FORCE_FAULT, 'user', async (kind: FaultKind) => {
    if (getHardware().driverKind !== 'simulator') {
      throw new CommandError(ErrorCode.INVALID_INPUT, 'Fault simulation is only available on the simulator.')
    }
    await tests.forceFault(kind)
  })

  // --- reports --------------------------------------------------------------
  handle(IPC.REPORTS_GENERATE, 'user', (input: { chartPng?: string }) => generateReport(input?.chartPng))
  handle(IPC.REPORTS_OPEN_FOLDER, 'user', async () => {
    await shell.openPath(reportDir())
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

/** Fan events out to every renderer window. */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}
