import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type Calibration,
  type CalibrationCapture,
  type CalibrationDraft,
  type CalibrationPolicy,
  type CalibrationStatus,
  type CertificateDraft,
  type ConnectionEvent,
  type CycleCompleteEvent,
  type HardwareConfig,
  type HardwareSnapshot,
  type HardwareStatus,
  type IpcResult,
  type JogDirection,
  type MachineMode,
  type MachineSettings,
  type ModelConfig,
  type ReportResult,
  type SerialPortInfo,
  type SpeedSettings,
  type StartRunRequest,
  type SystemInfo,
  type TelemetryFrame,
  type TestRunSummary,
  type UserAccount
} from '@shared/types'

function invoke<T>(channel: string, payload?: unknown): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, payload)
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  app: {
    quit: () => invoke<void>(IPC.APP_QUIT),
    systemInfo: () => invoke<SystemInfo>(IPC.APP_SYSTEM_INFO)
  },
  auth: {
    login: (username: string, password: string) =>
      invoke<UserAccount>(IPC.AUTH_LOGIN, { username, password }),
    logout: () => invoke<boolean>(IPC.AUTH_LOGOUT),
    adminCheck: (password: string) => invoke<boolean>(IPC.AUTH_ADMIN_CHECK, password),
    adminLock: () => invoke<boolean>(IPC.AUTH_ADMIN_LOCK)
  },
  users: {
    list: () => invoke<UserAccount[]>(IPC.USERS_LIST),
    rename: (id: number, displayName: string) =>
      invoke<UserAccount[]>(IPC.USERS_RENAME, { id, displayName }),
    changePassword: (id: number, password: string) =>
      invoke<boolean>(IPC.USERS_CHANGE_PASSWORD, { id, password })
  },
  models: {
    list: () => invoke<ModelConfig[]>(IPC.MODELS_LIST),
    save: (model: Omit<ModelConfig, 'id'> & { id?: number }) =>
      invoke<ModelConfig[]>(IPC.MODELS_SAVE, model),
    remove: (id: number) => invoke<ModelConfig[]>(IPC.MODELS_DELETE, id)
  },
  settings: {
    getAll: () => invoke<Record<string, string>>(IPC.SETTINGS_GET_ALL),
    setSpeeds: (speeds: SpeedSettings) => invoke<SpeedSettings>(IPC.SETTINGS_SET_SPEEDS, speeds),
    setReportDir: (dir: string) => invoke<string>(IPC.SETTINGS_SET_REPORT_DIR, dir),
    pickReportDir: () => invoke<string>(IPC.SETTINGS_PICK_REPORT_DIR),
    setMachine: (settings: MachineSettings) =>
      invoke<MachineSettings>(IPC.SETTINGS_SET_MACHINE, settings)
  },
  hardware: {
    getConfig: () => invoke<HardwareConfig>(IPC.HARDWARE_GET_CONFIG),
    setConfig: (config: HardwareConfig) => invoke<HardwareConfig>(IPC.HARDWARE_SET_CONFIG, config),
    testConnection: (config: HardwareConfig) =>
      invoke<{ status: string; loadN: number; heightMm: number }>(
        IPC.HARDWARE_TEST_CONNECTION,
        config
      ),
    listPorts: () => invoke<SerialPortInfo[]>(IPC.HARDWARE_LIST_PORTS),
    reconnect: () => invoke<boolean>(IPC.HARDWARE_RECONNECT)
  },
  machine: {
    snapshot: () => invoke<HardwareSnapshot>(IPC.MACHINE_SNAPSHOT),
    start: (request: StartRunRequest) => invoke<void>(IPC.MACHINE_START, request),
    stop: () => invoke<void>(IPC.MACHINE_STOP),
    reset: () => invoke<void>(IPC.MACHINE_RESET),
    home: () => invoke<void>(IPC.MACHINE_HOME),
    setMode: (mode: MachineMode) => invoke<void>(IPC.MACHINE_SET_MODE, mode),
    jog: (direction: JogDirection, active: boolean) =>
      invoke<void>(IPC.MACHINE_JOG, { direction, active }),
    forceFault: (kind: string) => invoke<void>(IPC.MACHINE_FORCE_FAULT, kind),
    onTelemetry: (cb: (frame: TelemetryFrame) => void) => subscribe(IPC.EVT_TELEMETRY, cb),
    onStatus: (cb: (status: HardwareStatus) => void) => subscribe(IPC.EVT_STATUS, cb),
    onConnection: (cb: (event: ConnectionEvent) => void) => subscribe(IPC.EVT_CONNECTION, cb),
    onCycleComplete: (cb: (event: CycleCompleteEvent) => void) =>
      subscribe(IPC.EVT_CYCLE_COMPLETE, cb)
  },
  calibration: {
    status: () => invoke<CalibrationStatus>(IPC.CAL_STATUS),
    history: () => invoke<Calibration[]>(IPC.CAL_HISTORY),
    capture: (durationMs?: number) => invoke<CalibrationCapture>(IPC.CAL_CAPTURE, { durationMs }),
    save: (draft: CalibrationDraft) => invoke<Calibration>(IPC.CAL_SAVE, draft),
    setPolicy: (policy: CalibrationPolicy) => invoke<CalibrationPolicy>(IPC.CAL_SET_POLICY, policy),
    simulateLoad: (loadN: number | null) => invoke<boolean>(IPC.CAL_SIMULATE_LOAD, loadN),
    saveCertificate: (draft: CertificateDraft) =>
      invoke<CalibrationStatus>(IPC.CERT_SAVE, draft),
    attachCertificate: () => invoke<CalibrationStatus>(IPC.CERT_ATTACH),
    openCertificate: () => invoke<boolean>(IPC.CERT_OPEN)
  },
  reports: {
    lastRun: () => invoke<TestRunSummary | null>(IPC.REPORTS_LAST_RUN),
    runPoints: () =>
      invoke<{
        run: TestRunSummary
        points: { loadN: number; heightMm: number }[]
        envelope: { loadN: number; heightMm: number }[]
        maxHeightMm: number
      }>(IPC.REPORTS_RUN_POINTS),
    generate: (chartPng?: string) => invoke<ReportResult>(IPC.REPORTS_GENERATE, { chartPng }),
    openFolder: () => invoke<boolean>(IPC.REPORTS_OPEN_FOLDER)
  }
}

export type PltmApi = typeof api

contextBridge.exposeInMainWorld('pltm', api)
