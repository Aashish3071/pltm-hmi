/** Machine status values, mirroring the PLTM user manual's status table. */
export const HardwareStatus = {
  DISCONNECTED: 'DISCONNECTED',
  READY: 'READY',
  EMERGENCY_PRESSED: 'EMERGENCY PRESSED',
  SERVO_ERROR: 'SERVO ERROR',
  OVERLOAD: 'OVERLOAD',
  SERVO_OFF: 'SERVO OFF',
  HOMING_NOT_DONE: 'HOMING NOT DONE',
  HALT: 'HALT',
  PANTO_RAISING: 'PANTO RAISING',
  PANTO_RAISING_COMPLETED: 'PANTO RAISING COMPLETED',
  PANTO_RETRIEVING: 'PANTO RETRIVING',
  /** A travel limit switch was reached. */
  OVER_TRAVEL: 'OVER TRAVEL'
} as const
export type HardwareStatus = (typeof HardwareStatus)[keyof typeof HardwareStatus]

/** Statuses that represent a fault the operator must clear before running. */
export const FAULT_STATUSES: HardwareStatus[] = [
  HardwareStatus.EMERGENCY_PRESSED,
  HardwareStatus.SERVO_ERROR,
  HardwareStatus.OVERLOAD,
  HardwareStatus.SERVO_OFF,
  HardwareStatus.OVER_TRAVEL
]

export type MachineMode = 'AUTO' | 'MANUAL'
export type RunPhase = 'idle' | 'up' | 'down'
export type JogDirection = 'UP' | 'DOWN'

export interface TelemetryFrame {
  timestampMs: number
  /** ms since the current run started; 0 when idle. */
  tMs: number
  /** Calibrated load. */
  loadN: number
  /** Load before the calibration correction — what calibration captures. */
  loadRawN: number
  heightMm: number
  phase: RunPhase
  /** Live cycle timers, excluding time spent in HALT. */
  upCycleSec: number
  downCycleSec: number
  /** Carried on every frame so pendant-driven changes reach the UI promptly. */
  mode: MachineMode
  homed: boolean
}

export interface HardwareSnapshot {
  connected: boolean
  status: HardwareStatus
  mode: MachineMode
  homed: boolean
  /** True when RESET has been pressed since the last completed run. */
  resetSinceLastRun: boolean
  loadN: number
  heightMm: number
  phase: RunPhase
  upCycleSec: number
  downCycleSec: number
  /** Set while a run is in progress or paused; null once reset. */
  activeModelId: number | null
  loadRawN: number
  safety: SafetyState
}

/**
 * Safety signals as reported by the machine's PLC (or the simulator).
 * `null` = that signal is not mapped, so the app cannot see it.
 */
export interface SafetyState {
  estop: boolean | null
  overloadTrip: boolean | null
  upperLimit: boolean | null
  lowerLimit: boolean | null
  /** The app is feeding the PLC's communication watchdog. */
  heartbeat: boolean
  source: 'plc' | 'simulator'
}

export interface CycleCompleteEvent {
  phase: 'up' | 'down'
  elapsedSec: number
}

export interface ConnectionEvent {
  connected: boolean
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
  distanceMm: number
  points: ModelPoint[]
}

export interface UserAccount {
  id: number
  slot: string
  displayName: string
  role: 'admin' | 'operator'
}

export interface SystemInfo {
  machineId: string
  deviceIp: string
  loadCapacityN: number
  heightCapacityMm: number
  appVersion: string
  driver: HardwareDriver
}

export interface MachineSettings {
  machineId: string
  loadCapacityN: number
  heightCapacityMm: number
  /** Printed on test certificates. */
  companyName: string
  companyAddress: string
}

/** Upper bound for any configured speed, in mm/s. */
export const MAX_SPEED_MM_S = 500

// ---------------------------------------------------------------------------
// Hardware driver configuration
// ---------------------------------------------------------------------------

export type HardwareDriver = 'simulator' | 'modbus'

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

/** A digital signal read from the PLC; `activeValue` (default 1) means the condition is present. */
export interface SignalSpec extends RegisterSpec {
  activeValue?: number
}

/**
 * Safety functions live in the PLC and its wiring; these are how the app sees
 * them. See docs/plc-safety-requirements.md.
 */
export interface SafetyMap {
  /** E-stop chain open (pressed). */
  estop: SignalSpec | null
  /** PLC overload trip latched. */
  overloadTrip: SignalSpec | null
  /** Upper / lower over-travel limit switch reached. */
  upperLimit: SignalSpec | null
  lowerLimit: SignalSpec | null
  /** Holding register the app increments every 500 ms; the PLC stops motion if it stalls. */
  heartbeat: RegisterSpec | null
}

/** A command written to the PLC. `pulseMs` > 0 writes `value`, then 0 after the delay. */
export interface CommandSpec {
  area: 'coil' | 'holding'
  address: number
  value?: number
  pulseMs?: number
}

export interface RegisterMap {
  load: RegisterSpec
  position: RegisterSpec
  status: RegisterSpec
  /** Raw status register value -> machine status. */
  statusCodes: Record<string, HardwareStatus>
  mode: RegisterSpec | null
  /** Raw mode value meaning MANUAL; anything else is AUTO. */
  manualModeValue: number
  homed: RegisterSpec | null
  commands: {
    start: CommandSpec
    stop: CommandSpec
    reset: CommandSpec
    home: CommandSpec
    jogUp: CommandSpec | null
    jogDown: CommandSpec | null
    modeAuto: CommandSpec | null
    modeManual: CommandSpec | null
  }
  writes: {
    upSpeed: RegisterSpec | null
    downSpeed: RegisterSpec | null
    jogSpeed: RegisterSpec | null
    /** Travel distance (row 4 height), written before each START. */
    travelDistance: RegisterSpec | null
    /** Load capacity (N) the PLC trips at; written on connect and when changed. */
    overloadLimit: RegisterSpec | null
    /** Height capacity (mm), the PLC's soft travel limit; written on connect and when changed. */
    travelLimit: RegisterSpec | null
  }
  safety: SafetyMap
}

export interface HardwareConfig {
  driver: HardwareDriver
  connection: ModbusConnection
  registerMap: RegisterMap
}

export interface SerialPortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
  /** Adapter chip family recognised from the USB vendor id, e.g. "FTDI". */
  chip?: string
}

// ---------------------------------------------------------------------------
// Load-cell calibration
// ---------------------------------------------------------------------------

export interface CalibrationPoint {
  /** Known applied force from the reference weight or reference load cell. */
  referenceN: number
  /** Averaged raw reading captured for it. */
  rawN: number
  /** Reading after applying this calibration. */
  correctedN: number
  errorN: number
}

export interface Calibration {
  id: number
  performedAt: string
  performedBy: string
  /** corrected = gain × raw + offset */
  gain: number
  offset: number
  points: CalibrationPoint[]
  maxErrorN: number
  maxPermissibleErrorN: number
  passed: boolean
  referenceDevice: string
  referenceCertificateNo: string
  /** YYYY-MM-DD */
  dueDate: string
  notes: string
}

/** The accredited (NABL / ISO/IEC 17025) certificate for the bench's load cell. */
export interface LoadCellCertificate {
  id: number
  labName: string
  accreditationNo: string
  certificateNo: string
  loadCellSerial: string
  /** YYYY-MM-DD */
  calibratedOn: string
  /** YYYY-MM-DD */
  validUntil: string
  uncertainty: string
  fileName: string | null
}

export type ValidityState = 'ok' | 'due-soon' | 'overdue' | 'missing'

export interface CalibrationPolicy {
  /** What happens when calibration or the certificate is overdue or missing. */
  enforcement: 'warn' | 'block'
  intervalMonths: number
  maxPermissibleErrorN: number
}

export interface CalibrationStatus {
  calibration: Calibration | null
  certificate: LoadCellCertificate | null
  calibrationState: ValidityState
  certificateState: ValidityState
  daysToCalibrationDue: number | null
  daysToCertificateDue: number | null
  policy: CalibrationPolicy
  /** Calibration is enforced on the real machine only, not on the simulator. */
  applies: boolean
  /** Tests are blocked right now because of calibration. */
  blocking: boolean
}

export interface CalibrationCapture {
  rawN: number
  stdDevN: number
  samples: number
  stable: boolean
}

export interface CalibrationDraft {
  points: { referenceN: number; rawN: number }[]
  referenceDevice: string
  referenceCertificateNo: string
  notes: string
}

export interface CertificateDraft {
  labName: string
  accreditationNo: string
  certificateNo: string
  loadCellSerial: string
  calibratedOn: string
  validUntil: string
  uncertainty: string
}

export interface ReportResult {
  excelPath: string
  pdfPath: string
  certificateNo: string
}

export interface TestRunSummary {
  id: number
  employeeName: string | null
  modelName: string | null
  partNo: string | null
  startedAt: string
  endedAt: string | null
  upCycleSec: number | null
  downCycleSec: number | null
  maxLoadN: number | null
  resultStatus: string | null
  reportPath: string | null
}

export interface StartRunRequest {
  modelId: number
  employeeUserId: number
  partNo: string
}

/** Error codes returned by machine commands; the renderer maps these to messages. */
export const ErrorCode = {
  NOT_HOMED: 'ERR_NOT_HOMED',
  RESET_REQUIRED: 'ERR_RESET_REQUIRED',
  HARDWARE_DISCONNECTED: 'ERR_HARDWARE_DISCONNECTED',
  FAULT_ACTIVE: 'ERR_FAULT_ACTIVE',
  ALREADY_RUNNING: 'ERR_ALREADY_RUNNING',
  NOT_RUNNING: 'ERR_NOT_RUNNING',
  MANUAL_MODE: 'ERR_MANUAL_MODE',
  NO_MODEL: 'ERR_NO_MODEL',
  INVALID_CREDENTIALS: 'ERR_INVALID_CREDENTIALS',
  NO_COMPLETED_RUN: 'ERR_NO_COMPLETED_RUN',
  HOMING_BLOCKED: 'ERR_HOMING_BLOCKED',
  INVALID_INPUT: 'ERR_INVALID_INPUT',
  DUPLICATE_NAME: 'ERR_DUPLICATE_NAME',
  NOT_AUTHORIZED: 'ERR_NOT_AUTHORIZED',
  CONNECTION_FAILED: 'ERR_CONNECTION_FAILED',
  CALIBRATION_REQUIRED: 'ERR_CALIBRATION_REQUIRED',
  INTERNAL: 'ERR_INTERNAL'
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.HOMING_BLOCKED]: 'Cannot home while a test is in progress. Press RESET first.',
  [ErrorCode.INVALID_INPUT]: 'Invalid input.',
  [ErrorCode.DUPLICATE_NAME]: 'That name is already in use.',
  [ErrorCode.NOT_AUTHORIZED]: 'Administrator access is required for this action.',
  [ErrorCode.CONNECTION_FAILED]: 'Could not connect to the machine.',
  [ErrorCode.CALIBRATION_REQUIRED]:
    'Load-cell calibration or its certificate is overdue. An administrator must calibrate before testing.',
  [ErrorCode.INTERNAL]: 'Unexpected error. Details were written to the application log.',
  [ErrorCode.NOT_HOMED]: 'Homing not done. Press HOMING before starting a test.',
  [ErrorCode.RESET_REQUIRED]: 'Press RESET before starting a new test cycle.',
  [ErrorCode.HARDWARE_DISCONNECTED]: 'Machine is disconnected. Check power and the Ethernet cable.',
  [ErrorCode.FAULT_ACTIVE]: 'A fault is active. Clear the fault and press RESET.',
  [ErrorCode.ALREADY_RUNNING]: 'A test is already running.',
  [ErrorCode.NOT_RUNNING]: 'No test is currently running.',
  [ErrorCode.MANUAL_MODE]: 'Machine is in MANUAL mode. Switch to AUTO mode to run a test.',
  [ErrorCode.NO_MODEL]: 'Select a model and press OK before starting a test.',
  [ErrorCode.INVALID_CREDENTIALS]: 'Invalid username or password.',
  [ErrorCode.NO_COMPLETED_RUN]: 'No completed test run available to report.'
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
  USERS_RENAME: 'users:rename',
  USERS_CHANGE_PASSWORD: 'users:change-password',

  MODELS_LIST: 'models:list',
  MODELS_SAVE: 'models:save',
  MODELS_DELETE: 'models:delete',

  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_SET_SPEEDS: 'settings:set-speeds',
  SETTINGS_SET_REPORT_DIR: 'settings:set-report-dir',
  SETTINGS_PICK_REPORT_DIR: 'settings:pick-report-dir',
  SETTINGS_SET_MACHINE: 'settings:set-machine',

  HARDWARE_GET_CONFIG: 'hardware:get-config',
  HARDWARE_SET_CONFIG: 'hardware:set-config',
  HARDWARE_TEST_CONNECTION: 'hardware:test-connection',
  HARDWARE_LIST_PORTS: 'hardware:list-ports',
  HARDWARE_RECONNECT: 'hardware:reconnect',

  MACHINE_SNAPSHOT: 'machine:snapshot',
  MACHINE_START: 'machine:start',
  MACHINE_STOP: 'machine:stop',
  MACHINE_RESET: 'machine:reset',
  MACHINE_HOME: 'machine:home',
  MACHINE_SET_MODE: 'machine:set-mode',
  MACHINE_JOG: 'machine:jog',
  MACHINE_FORCE_FAULT: 'machine:force-fault',

  REPORTS_GENERATE: 'reports:generate',
  REPORTS_OPEN_FOLDER: 'reports:open-folder',
  REPORTS_LAST_RUN: 'reports:last-run',
  REPORTS_RUN_POINTS: 'reports:run-points',

  CAL_STATUS: 'calibration:status',
  CAL_HISTORY: 'calibration:history',
  CAL_CAPTURE: 'calibration:capture',
  CAL_SAVE: 'calibration:save',
  CAL_SET_POLICY: 'calibration:set-policy',
  CAL_SIMULATE_LOAD: 'calibration:simulate-load',
  CERT_SAVE: 'certificate:save',
  CERT_ATTACH: 'certificate:attach',
  CERT_OPEN: 'certificate:open',

  /** main -> renderer push events */
  EVT_TELEMETRY: 'evt:telemetry',
  EVT_STATUS: 'evt:status',
  EVT_CONNECTION: 'evt:connection',
  EVT_CYCLE_COMPLETE: 'evt:cycle-complete'
} as const
