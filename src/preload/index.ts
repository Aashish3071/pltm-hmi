import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type BackupInfo,
  type BackupStatus,
  type ConnectionTestResult,
  type GraphHistory,
  type HardwareConfig,
  type IpcResult,
  type MachineEvent,
  type MachineSettings,
  type ModelConfig,
  type ModelDraft,
  type PlcState,
  type RecoveryRequest,
  type ReportResult,
  type Selection,
  type SerialPortInfo,
  type SpeedSettings,
  type SystemInfo,
  type TestRunDetail,
  type TestRunPage,
  type TestRunQuery,
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
    quit: () => invoke<boolean>(IPC.APP_QUIT),
    systemInfo: () => invoke<SystemInfo>(IPC.APP_SYSTEM_INFO)
  },
  auth: {
    login: (username: string, password: string) => invoke<UserAccount>(IPC.AUTH_LOGIN, { username, password }),
    logout: () => invoke<boolean>(IPC.AUTH_LOGOUT),
    adminCheck: (username: string, password: string) =>
      invoke<boolean>(IPC.AUTH_ADMIN_CHECK, { username, password }),
    adminLock: () => invoke<boolean>(IPC.AUTH_ADMIN_LOCK),
    recoveryRequest: () => invoke<RecoveryRequest>(IPC.AUTH_RECOVERY_REQUEST),
    recoveryComplete: (response: string, password: string) =>
      invoke<boolean>(IPC.AUTH_RECOVERY_COMPLETE, { response, password })
  },
  users: {
    list: () => invoke<UserAccount[]>(IPC.USERS_LIST),
    saveNames: (names: string[]) => invoke<UserAccount[]>(IPC.USERS_SAVE_NAMES, names),
    changePassword: (id: number, password: string) =>
      invoke<boolean>(IPC.USERS_CHANGE_PASSWORD, { id, password })
  },
  models: {
    list: () => invoke<ModelConfig[]>(IPC.MODELS_LIST),
    save: (draft: ModelDraft) => invoke<{ models: ModelConfig[]; current: ModelConfig }>(IPC.MODELS_SAVE, draft)
  },
  settings: {
    get: () =>
      invoke<{ speeds: SpeedSettings; distanceMm: number; machine: MachineSettings; reportDir: string }>(
        IPC.SETTINGS_GET
      ),
    upload: (speeds: SpeedSettings, distanceMm: number) => invoke<void>(IPC.SETTINGS_UPLOAD, { speeds, distanceMm }),
    setMachine: (settings: MachineSettings) => invoke<MachineSettings>(IPC.SETTINGS_SET_MACHINE, settings),
    setReportDir: (dir: string) => invoke<string>(IPC.SETTINGS_SET_REPORT_DIR, dir),
    pickReportDir: () => invoke<string>(IPC.SETTINGS_PICK_REPORT_DIR)
  },
  hardware: {
    getConfig: () => invoke<HardwareConfig>(IPC.HARDWARE_GET_CONFIG),
    setConfig: (config: HardwareConfig) => invoke<HardwareConfig>(IPC.HARDWARE_SET_CONFIG, config),
    testConnection: (config: HardwareConfig) => invoke<ConnectionTestResult>(IPC.HARDWARE_TEST_CONNECTION, config),
    listPorts: () => invoke<SerialPortInfo[]>(IPC.HARDWARE_LIST_PORTS),
    reconnect: () => invoke<boolean>(IPC.HARDWARE_RECONNECT)
  },
  machine: {
    state: () => invoke<PlcState>(IPC.MACHINE_STATE),
    selection: () => invoke<Selection>(IPC.MACHINE_SELECTION),
    select: (modelId: number, partNo: string) => invoke<Selection>(IPC.MACHINE_SELECT, { modelId, partNo }),
    history: () => invoke<GraphHistory>(IPC.MACHINE_HISTORY),
    start: () => invoke<void>(IPC.MACHINE_START),
    stop: () => invoke<void>(IPC.MACHINE_STOP),
    reset: () => invoke<void>(IPC.MACHINE_RESET),
    home: () => invoke<void>(IPC.MACHINE_HOME),
    forceFault: (kind: string) => invoke<void>(IPC.MACHINE_FORCE_FAULT, kind),
    onEvent: (cb: (event: MachineEvent) => void) => subscribe(IPC.EVT_MACHINE, cb)
  },
  reports: {
    generate: (chartPng?: string, runId?: number) => invoke<ReportResult>(IPC.REPORTS_GENERATE, { chartPng, runId }),
    openFolder: (runId?: number) => invoke<boolean>(IPC.REPORTS_OPEN_FOLDER, runId),
    search: (query: TestRunQuery) => invoke<TestRunPage>(IPC.REPORTS_SEARCH, query),
    run: (runId: number) => invoke<TestRunDetail>(IPC.REPORTS_RUN, runId)
  },
  backup: {
    status: () => invoke<BackupStatus>(IPC.BACKUP_STATUS),
    now: () => invoke<BackupStatus>(IPC.BACKUP_NOW),
    pickDir: () => invoke<BackupStatus>(IPC.BACKUP_PICK_DIR),
    pickRestore: () => invoke<BackupInfo | null>(IPC.BACKUP_PICK_RESTORE),
    restore: (folder: string) => invoke<boolean>(IPC.BACKUP_RESTORE, folder)
  }
}

export type PltmApi = typeof api

contextBridge.exposeInMainWorld('pltm', api)
