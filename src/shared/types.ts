// ---------------------------------------------------------------------------
// PLC status codes.
// The PLC writes the code as the third field of its status string.
// ---------------------------------------------------------------------------

export const StatusCode = {
  READY: 0,
  EMERGENCY_PRESSED: 1,
  SERVO_ERROR: 11,
  OVERLOAD: 21,
  SERVO_OFF: 31,
  HOMING_NOT_DONE: 41,
  HALT: 51,
  PANTO_RAISING: 61,
  PANTO_RAISING_COMPLETED: 71,
  PANTO_RETRIEVING: 81,
  CYCLE_COMPLETED: 91,
  /** Not sent by the PLC: shown when the app cannot reach it. */
  ETHERNET_DISCONNECTED: 100
} as const
export type StatusCode = (typeof StatusCode)[keyof typeof StatusCode]

/** Status-bar texts. */
export const STATUS_TEXT: Record<number, string> = {
  0: 'READY',
  1: 'EMERGENCY PRESSED',
  11: 'SERVO ERROR',
  21: 'OVERLOAD',
  31: 'SERVO OFF',
  41: 'HOMING NOT DONE',
  51: 'HALT',
  61: 'PANTO RAISING',
  71: 'PANTO RAISING COMPLETED',
  81: 'PANTO RETRIEVING',
  91: 'CYCLE COMPLETED',
  100: 'ETHERNET DISCONNECTED'
}

/** Codes recorded on the raising (up) branch of the curve, and on the lowering branch. */
export const RAISING_CODES: number[] = [StatusCode.PANTO_RAISING, StatusCode.PANTO_RAISING_COMPLETED]
export const LOWERING_CODES: number[] = [StatusCode.PANTO_RETRIEVING]
/** Codes that light the alarm bell. */
export const ALARM_CODES: number[] = [
  StatusCode.EMERGENCY_PRESSED,
  StatusCode.SERVO_ERROR,
  StatusCode.OVERLOAD,
  StatusCode.SERVO_OFF,
  StatusCode.HOMING_NOT_DONE,
  StatusCode.ETHERNET_DISCONNECTED
]

export function statusText(state: Pick<PlcState, 'connected' | 'code'>): string {
  if (!state.connected) return STATUS_TEXT[StatusCode.ETHERNET_DISCONNECTED]
  return STATUS_TEXT[state.code] ?? ''
}

export type MachineMode = 'MANUAL' | 'AUTO'

/** One poll of the PLC: the six values of its status string, decoded. */
export interface PlcState {
  connected: boolean
  timestampMs: number
  loadN: number
  positionMm: number
  code: number
  upTimeSec: number
  downTimeSec: number
  /** null when the PLC does not report it. */
  mode: MachineMode | null
}

/** Pushed to the renderer on every poll. */
export interface MachineEvent {
  state: PlcState
  /** The poll was appended to the current test (n) — the graph adds it. */
  recorded: boolean
  /** Bumped whenever the n / n-1 / n-2 history changes (START of a new test, RESET). */
  historyVersion: number
}

/** A recorded reading: load (N), position (mm) and the PLC status code at the time. */
export interface Sample {
  loadN: number
  positionMm: number
  code: number
}

export interface GraphHistory {
  version: number
  n: Sample[]
  n1: Sample[]
  n2: Sample[]
}

export interface SpeedSettings {
  up: number
  down: number
  jog: number
}

export interface ModelPoint {
  rowIndex: number
  loadN: number
  heightMm: number
}

export interface ModelConfig {
  id: number
  name: string
  /** Travel distance — the 4th height point. */
  distanceMm: number
  points: ModelPoint[]
}

export interface ModelDraft {
  /** The model being edited (the one selected on the Home screen). */
  id?: number
  name: string
  points: ModelPoint[]
}

export interface UserAccount {
  id: number
  slot: string
  displayName: string
  role: 'admin' | 'operator'
}

/** What the Home screen shows from the last OK. */
export interface Selection {
  modelId: number
  modelName: string
  partNo: string
}

export interface TestResults {
  avgUpN: number
  avgDownN: number
  meanN: number
  peakFrictionN: number
  hysteresisN: number
  maxHeightMm: number
  /** Heights the averages were taken between. */
  windowFromMm: number
  windowToMm: number
}

export interface CompanyInfo {
  name: string
  addressLine1: string
  addressLine2: string
}

export interface MachineSettings {
  machineId: string
  loadCapacityKg: number
  heightCapacityMm: number
  company: CompanyInfo
  /** Printed as "speed of meas." on the report. */
  measurementSpeedText: string
}

export interface SystemInfo {
  machineId: string
  deviceIp: string
  loadCapacityKg: number
  heightCapacityMm: number
  appVersion: string
  driver: HardwareDriver
}

// ---------------------------------------------------------------------------
// Hardware drivers
// ---------------------------------------------------------------------------

export type HardwareDriver = 'simulator' | 's7' | 'modbus'

/** Siemens S7 over Ethernet (ISO-on-TCP, port 102). */
export interface S7Connection {
  host: string
  port: number
  rack: number
  slot: number
  timeoutMs: number
  pollIntervalMs: number
}

export interface S7Bit {
  byte: number
  bit: number
}

export interface S7Command extends S7Bit {
  /** > 0: set the bit, then clear it after this delay. 0: set it and leave it for the PLC to clear. */
  pulseMs: number
}

/** Addresses inside the PLC's data block. REAL values are 4-byte big-endian floats. */
export interface S7Map {
  dbNumber: number
  /** STRING holding "load×100 position status uptime downtime mode". */
  statusString: { offset: number; maxLength: number }
  /** The first field is load × this divisor. */
  loadDivisor: number
  commands: {
    start: S7Command
    /** STOP sets this bit; START clears it again (resume). */
    stop: S7Bit
    reset: S7Command
    home: S7Command
  }
  /** REAL byte offsets, or null when not written. */
  writes: {
    upSpeed: number | null
    downSpeed: number | null
    jogSpeed: number | null
    distance: number | null
  }
}

/**
 * rtu-serial: Modbus RTU on a COM port (RS-485/RS-232 adapter).
 * rtu-tcp:    Modbus RTU frames tunnelled through a serial-to-Ethernet gateway.
 * tcp:        Modbus TCP (MBAP), for gateways/PLCs that speak it natively.
 */
export type ModbusTransport = 'rtu-serial' | 'rtu-tcp' | 'tcp'

export interface ModbusConnection {
  transport: ModbusTransport
  serialPath: string
  baudRate: number
  parity: 'none' | 'even' | 'odd'
  dataBits: 7 | 8
  stopBits: 1 | 2
  host: string
  port: number
  unitId: number
  timeoutMs: number
  pollIntervalMs: number
}

export type RegisterArea = 'holding' | 'input' | 'coil' | 'discrete'
export type RegisterDataType = 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32'

/** A value read from (or written to) the PLC. Engineering value = raw * scale. */
export interface RegisterSpec {
  area: RegisterArea
  address: number
  dataType?: RegisterDataType
  /** Word order for 32-bit types: BE = high word first. */
  wordOrder?: 'BE' | 'LE'
  scale?: number
}

/** A command written to the PLC. `pulseMs` > 0 writes `value`, then 0 after the delay. */
export interface CommandSpec {
  area: 'coil' | 'holding'
  address: number
  value?: number
  pulseMs?: number
}

/** The same six values as the S7 status string, one register each. */
export interface ModbusMap {
  load: RegisterSpec
  position: RegisterSpec
  /** Holds the status code (0, 1, 11 … 91). */
  status: RegisterSpec
  upTime: RegisterSpec | null
  downTime: RegisterSpec | null
  /** 1 = MANUAL, 2 = AUTO. */
  mode: RegisterSpec | null
  commands: {
    start: CommandSpec
    stop: CommandSpec
    /** Written by START before the start command (clears a STOP). */
    resume: CommandSpec | null
    reset: CommandSpec
    home: CommandSpec
  }
  writes: {
    upSpeed: RegisterSpec | null
    downSpeed: RegisterSpec | null
    jogSpeed: RegisterSpec | null
    distance: RegisterSpec | null
  }
}

export interface HardwareConfig {
  driver: HardwareDriver
  s7: { connection: S7Connection; map: S7Map }
  modbus: { connection: ModbusConnection; map: ModbusMap }
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
  /** Adapter chip family recognised from the USB vendor id, e.g. "FTDI". */
  chip?: string
}

export interface ConnectionTestResult {
  status: string
  loadN: number
  positionMm: number
}

export interface ReportResult {
  excelPath: string
  pdfPath: string
  jsonPath: string
}

/** Message boxes: an icon, a title and a text. */
export interface MessageInfo {
  icon: 'information' | 'critical' | 'warning'
  title: string
  text: string
}

/** Error codes returned by commands; the renderer shows the message in a message box. */
export const ErrorCode = {
  HARDWARE_DISCONNECTED: 'ERR_HARDWARE_DISCONNECTED',
  NO_MODEL: 'ERR_NO_MODEL',
  INVALID_CREDENTIALS: 'ERR_INVALID_CREDENTIALS',
  NO_TEST: 'ERR_NO_TEST',
  INVALID_INPUT: 'ERR_INVALID_INPUT',
  DUPLICATE_NAME: 'ERR_DUPLICATE_NAME',
  NOT_AUTHORIZED: 'ERR_NOT_AUTHORIZED',
  CONNECTION_FAILED: 'ERR_CONNECTION_FAILED',
  INTERNAL: 'ERR_INTERNAL'
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.HARDWARE_DISCONNECTED]: 'ETHERNET DISCONNECTED. Check the PLC power and the Ethernet cable.',
  [ErrorCode.NO_MODEL]: 'Select a model and press OK.',
  [ErrorCode.INVALID_CREDENTIALS]: 'You have Entered Incorrect Password',
  [ErrorCode.NO_TEST]: 'No test data to report. Run a test first.',
  [ErrorCode.INVALID_INPUT]: 'Invalid input.',
  [ErrorCode.DUPLICATE_NAME]: 'That name is already in use.',
  [ErrorCode.NOT_AUTHORIZED]: 'Administrator access is required for this action.',
  [ErrorCode.CONNECTION_FAILED]: 'Could not connect to the machine.',
  [ErrorCode.INTERNAL]: 'Unexpected error. Details were written to the application log.'
}

/** Uniform result shape for every invoke-style IPC call. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string }

export const IPC = {
  APP_QUIT: 'app:quit',
  APP_SYSTEM_INFO: 'app:system-info',

  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_ADMIN_CHECK: 'auth:admin-check',
  AUTH_ADMIN_LOCK: 'auth:admin-lock',

  USERS_LIST: 'users:list',
  USERS_SAVE_NAMES: 'users:save-names',
  USERS_CHANGE_PASSWORD: 'users:change-password',

  MODELS_LIST: 'models:list',
  MODELS_SAVE: 'models:save',

  SETTINGS_GET: 'settings:get',
  SETTINGS_UPLOAD: 'settings:upload',
  SETTINGS_SET_MACHINE: 'settings:set-machine',
  SETTINGS_SET_REPORT_DIR: 'settings:set-report-dir',
  SETTINGS_PICK_REPORT_DIR: 'settings:pick-report-dir',

  HARDWARE_GET_CONFIG: 'hardware:get-config',
  HARDWARE_SET_CONFIG: 'hardware:set-config',
  HARDWARE_TEST_CONNECTION: 'hardware:test-connection',
  HARDWARE_LIST_PORTS: 'hardware:list-ports',
  HARDWARE_RECONNECT: 'hardware:reconnect',

  MACHINE_STATE: 'machine:state',
  MACHINE_SELECT: 'machine:select',
  MACHINE_SELECTION: 'machine:selection',
  MACHINE_START: 'machine:start',
  MACHINE_STOP: 'machine:stop',
  MACHINE_RESET: 'machine:reset',
  MACHINE_HOME: 'machine:home',
  MACHINE_HISTORY: 'machine:history',
  MACHINE_FORCE_FAULT: 'machine:force-fault',

  REPORTS_GENERATE: 'reports:generate',
  REPORTS_OPEN_FOLDER: 'reports:open-folder',

  /** main -> renderer push events */
  EVT_MACHINE: 'evt:machine'
} as const
