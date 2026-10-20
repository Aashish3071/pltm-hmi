import {
  HardwareStatus,
  type CommandSpec,
  type HardwareDriver,
  type ModbusConnection,
  type RegisterMap,
  type RegisterSpec
} from '@shared/types'

export const DEFAULT_CONNECTION: ModbusConnection = {
  transport: 'rtu-tcp',
  serialPath: 'COM3',
  baudRate: 9600,
  parity: 'none',
  dataBits: 8,
  stopBits: 1,
  host: '192.168.0.1',
  port: 4840,
  unitId: 1,
  timeoutMs: 1000,
  pollIntervalMs: 100
}

/**
 * PLACEHOLDER register map. The real addresses must come from the PLC
 * programmer / machine vendor; this layout only exists so the driver can be
 * exercised end-to-end. It is never used unless an admin switches the driver
 * to Modbus in Settings.
 */
export const DEFAULT_REGISTER_MAP: RegisterMap = {
  load: { area: 'input', address: 0, dataType: 'int32', wordOrder: 'BE', scale: 0.01 },
  position: { area: 'input', address: 2, dataType: 'int32', wordOrder: 'BE', scale: 0.01 },
  status: { area: 'input', address: 4, dataType: 'uint16' },
  statusCodes: {
    '0': HardwareStatus.HOMING_NOT_DONE,
    '1': HardwareStatus.READY,
    '2': HardwareStatus.PANTO_RAISING,
    '3': HardwareStatus.PANTO_RAISING_COMPLETED,
    '4': HardwareStatus.PANTO_RETRIEVING,
    '5': HardwareStatus.HALT,
    '10': HardwareStatus.EMERGENCY_PRESSED,
    '11': HardwareStatus.SERVO_ERROR,
    '12': HardwareStatus.OVERLOAD,
    '13': HardwareStatus.SERVO_OFF
  },
  mode: { area: 'input', address: 5, dataType: 'uint16' },
  manualModeValue: 1,
  homed: { area: 'discrete', address: 0 },
  commands: {
    start: { area: 'coil', address: 0, value: 1, pulseMs: 200 },
    stop: { area: 'coil', address: 1, value: 1, pulseMs: 200 },
    reset: { area: 'coil', address: 2, value: 1, pulseMs: 200 },
    home: { area: 'coil', address: 3, value: 1, pulseMs: 200 },
    jogUp: { area: 'coil', address: 4, value: 1 },
    jogDown: { area: 'coil', address: 5, value: 1 },
    modeAuto: null,
    modeManual: null
  },
  writes: {
    upSpeed: { area: 'holding', address: 0, dataType: 'uint16', scale: 0.1 },
    downSpeed: { area: 'holding', address: 1, dataType: 'uint16', scale: 0.1 },
    jogSpeed: { area: 'holding', address: 2, dataType: 'uint16', scale: 0.1 },
    travelDistance: { area: 'holding', address: 3, dataType: 'uint16', scale: 1 }
  }
}

export class ConfigError extends Error {}

const AREAS = ['holding', 'input', 'coil', 'discrete'] as const
const DATA_TYPES = ['int16', 'uint16', 'int32', 'uint32', 'float32'] as const
const STATUSES = new Set<string>(Object.values(HardwareStatus))

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAddress(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535
}

function checkRegister(path: string, value: unknown, opts: { writable?: boolean } = {}): RegisterSpec {
  if (!isObject(value)) throw new ConfigError(`${path}: must be an object`)
  const { area, address, dataType, wordOrder, scale } = value
  if (!AREAS.includes(area as (typeof AREAS)[number])) {
    throw new ConfigError(`${path}.area: must be one of ${AREAS.join(', ')}`)
  }
  if (opts.writable && area !== 'holding') {
    throw new ConfigError(`${path}.area: values written to the PLC must be holding registers`)
  }
  if (!isAddress(address)) throw new ConfigError(`${path}.address: must be an integer 0-65535`)
  if (dataType !== undefined && !DATA_TYPES.includes(dataType as (typeof DATA_TYPES)[number])) {
    throw new ConfigError(`${path}.dataType: must be one of ${DATA_TYPES.join(', ')}`)
  }
  if (wordOrder !== undefined && wordOrder !== 'BE' && wordOrder !== 'LE') {
    throw new ConfigError(`${path}.wordOrder: must be BE or LE`)
  }
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale === 0)) {
    throw new ConfigError(`${path}.scale: must be a non-zero number`)
  }
  return value as unknown as RegisterSpec
}

function checkCommand(path: string, value: unknown): CommandSpec {
  if (!isObject(value)) throw new ConfigError(`${path}: must be an object`)
  const { area, address, value: written, pulseMs } = value
  if (area !== 'coil' && area !== 'holding') {
    throw new ConfigError(`${path}.area: commands must target a coil or holding register`)
  }
  if (!isAddress(address)) throw new ConfigError(`${path}.address: must be an integer 0-65535`)
  if (written !== undefined && !Number.isInteger(written)) {
    throw new ConfigError(`${path}.value: must be an integer`)
  }
  if (pulseMs !== undefined && (!Number.isInteger(pulseMs) || (pulseMs as number) < 0)) {
    throw new ConfigError(`${path}.pulseMs: must be a non-negative integer`)
  }
  return value as unknown as CommandSpec
}

function optional<T>(value: unknown, check: () => T): T | null {
  return value === null || value === undefined ? null : check()
}

export function validateRegisterMap(input: unknown): RegisterMap {
  if (!isObject(input)) throw new ConfigError('Register map must be a JSON object')
  const map = input
  checkRegister('load', map.load)
  checkRegister('position', map.position)
  checkRegister('status', map.status)
  optional(map.mode, () => checkRegister('mode', map.mode))
  optional(map.homed, () => checkRegister('homed', map.homed))

  if (!isObject(map.statusCodes) || Object.keys(map.statusCodes).length === 0) {
    throw new ConfigError('statusCodes: must map raw values to statuses')
  }
  for (const [raw, status] of Object.entries(map.statusCodes)) {
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`statusCodes: key "${raw}" must be an integer`)
    if (!STATUSES.has(status as string) || status === HardwareStatus.DISCONNECTED) {
      throw new ConfigError(`statusCodes["${raw}"]: unknown status "${String(status)}"`)
    }
  }
  if (!Number.isInteger(map.manualModeValue)) {
    throw new ConfigError('manualModeValue: must be an integer')
  }

  if (!isObject(map.commands)) throw new ConfigError('commands: must be an object')
  const commands = map.commands
  for (const name of ['start', 'stop', 'reset', 'home'] as const) {
    checkCommand(`commands.${name}`, commands[name])
  }
  for (const name of ['jogUp', 'jogDown', 'modeAuto', 'modeManual'] as const) {
    optional(commands[name], () => checkCommand(`commands.${name}`, commands[name]))
  }

  if (!isObject(map.writes)) throw new ConfigError('writes: must be an object')
  const writes = map.writes
  for (const name of ['upSpeed', 'downSpeed', 'jogSpeed', 'travelDistance'] as const) {
    optional(writes[name], () =>
      checkRegister(`writes.${name}`, writes[name], { writable: true })
    )
  }

  return input as unknown as RegisterMap
}

export function validateConnection(input: unknown): ModbusConnection {
  if (!isObject(input)) throw new ConfigError('Connection settings must be an object')
  const c = { ...DEFAULT_CONNECTION, ...input } as ModbusConnection
  if (!['rtu-serial', 'rtu-tcp', 'tcp'].includes(c.transport)) {
    throw new ConfigError('Transport must be RTU (serial), RTU over TCP, or Modbus TCP')
  }
  if (c.transport === 'rtu-serial' && !String(c.serialPath).trim()) {
    throw new ConfigError('Serial port is required for RTU (serial)')
  }
  if (c.transport !== 'rtu-serial') {
    if (!/^[\w.-]+$/.test(String(c.host))) throw new ConfigError('Enter a valid IP address or host')
    if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) {
      throw new ConfigError('Port must be 1-65535')
    }
  }
  if (![1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(c.baudRate)) {
    throw new ConfigError('Unsupported baud rate')
  }
  if (!['none', 'even', 'odd'].includes(c.parity)) throw new ConfigError('Parity must be none, even or odd')
  if (c.dataBits !== 7 && c.dataBits !== 8) throw new ConfigError('Data bits must be 7 or 8')
  if (c.stopBits !== 1 && c.stopBits !== 2) throw new ConfigError('Stop bits must be 1 or 2')
  if (!Number.isInteger(c.unitId) || c.unitId < 1 || c.unitId > 247) {
    throw new ConfigError('Slave ID must be 1-247')
  }
  if (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 10000) {
    throw new ConfigError('Timeout must be 100-10000 ms')
  }
  if (!Number.isInteger(c.pollIntervalMs) || c.pollIntervalMs < 50 || c.pollIntervalMs > 2000) {
    throw new ConfigError('Poll interval must be 50-2000 ms')
  }
  return c
}

export function validateDriver(input: unknown): HardwareDriver {
  if (input !== 'simulator' && input !== 'modbus') {
    throw new ConfigError('Driver must be simulator or modbus')
  }
  return input
}
