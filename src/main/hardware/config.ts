import type {
  CommandSpec,
  HardwareConfig,
  HardwareDriver,
  ModbusConnection,
  ModbusMap,
  RegisterSpec,
  S7Bit,
  S7Command,
  S7Connection,
  S7Map
} from '@shared/types'

// ---------------------------------------------------------------------------
// Siemens S7 — the machine PLC's data block interface
// ---------------------------------------------------------------------------

export const DEFAULT_S7_CONNECTION: S7Connection = {
  host: '192.168.0.1',
  port: 102,
  rack: 0,
  slot: 1,
  timeoutMs: 1000,
  pollIntervalMs: 25
}

/**
 * DB6 of the machine PLC:
 *   0.3 START_PB · 0.6 RESET_PB · 1.0 HOME_BN · 1.2 STOP_PB
 *   2 PANTO_UP_DIST · 6 / 10 / 14 UP / DOWN / JOG speed (REAL)
 *   1866 PANTO_LOAD_POS_STAT_STRG (STRING[50])
 */
export const DEFAULT_S7_MAP: S7Map = {
  dbNumber: 6,
  statusString: { offset: 1866, maxLength: 50 },
  loadDivisor: 100,
  commands: {
    start: { byte: 0, bit: 3, pulseMs: 0 },
    stop: { byte: 1, bit: 2 },
    reset: { byte: 0, bit: 6, pulseMs: 0 },
    home: { byte: 1, bit: 0, pulseMs: 2000 }
  },
  writes: { upSpeed: 6, downSpeed: 10, jogSpeed: 14, distance: 2 }
}

// ---------------------------------------------------------------------------
// Modbus — for PLCs that publish the same six values in registers
// ---------------------------------------------------------------------------

export const DEFAULT_MODBUS_CONNECTION: ModbusConnection = {
  transport: 'rtu-serial',
  serialPath: 'COM3',
  baudRate: 9600,
  parity: 'none',
  dataBits: 8,
  stopBits: 1,
  host: '192.168.0.1',
  port: 502,
  unitId: 1,
  timeoutMs: 1000,
  pollIntervalMs: 50
}

/** Example layout; the real addresses come from the PLC programmer. */
export const DEFAULT_MODBUS_MAP: ModbusMap = {
  load: { area: 'holding', address: 0, dataType: 'int32', wordOrder: 'BE', scale: 0.01 },
  position: { area: 'holding', address: 2, dataType: 'int32', wordOrder: 'BE', scale: 1 },
  status: { area: 'holding', address: 4, dataType: 'uint16' },
  upTime: { area: 'holding', address: 5, dataType: 'uint16' },
  downTime: { area: 'holding', address: 6, dataType: 'uint16' },
  mode: { area: 'holding', address: 7, dataType: 'uint16' },
  commands: {
    start: { area: 'coil', address: 3, value: 1 },
    stop: { area: 'coil', address: 10, value: 1 },
    resume: { area: 'coil', address: 10, value: 0 },
    reset: { area: 'coil', address: 6, value: 1 },
    home: { area: 'coil', address: 8, value: 1, pulseMs: 2000 }
  },
  writes: {
    upSpeed: { area: 'holding', address: 20, dataType: 'float32', wordOrder: 'BE' },
    downSpeed: { area: 'holding', address: 22, dataType: 'float32', wordOrder: 'BE' },
    jogSpeed: { area: 'holding', address: 24, dataType: 'float32', wordOrder: 'BE' },
    distance: { area: 'holding', address: 26, dataType: 'float32', wordOrder: 'BE' }
  }
}

export const DEFAULT_HARDWARE_CONFIG: HardwareConfig = {
  driver: 's7',
  s7: { connection: DEFAULT_S7_CONNECTION, map: DEFAULT_S7_MAP },
  modbus: { connection: DEFAULT_MODBUS_CONNECTION, map: DEFAULT_MODBUS_MAP }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ConfigError extends Error {}

const AREAS = ['holding', 'input', 'coil', 'discrete'] as const
const DATA_TYPES = ['int16', 'uint16', 'int32', 'uint32', 'float32'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInt(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max
}

function optional<T>(value: unknown, check: () => T): T | null {
  return value === null || value === undefined ? null : check()
}

export function validateDriver(input: unknown): HardwareDriver {
  if (input !== 'simulator' && input !== 's7' && input !== 'modbus') {
    throw new ConfigError('Driver must be simulator, s7 or modbus')
  }
  return input
}

function checkHost(host: unknown): void {
  if (!/^[\w.-]+$/.test(String(host ?? ''))) throw new ConfigError('Enter a valid IP address or host')
}

export function validateS7Connection(input: unknown): S7Connection {
  if (!isObject(input)) throw new ConfigError('S7 connection must be an object')
  const c = { ...DEFAULT_S7_CONNECTION, ...input } as S7Connection
  checkHost(c.host)
  if (!isInt(c.port, 1, 65535)) throw new ConfigError('Port must be 1-65535')
  if (!isInt(c.rack, 0, 7)) throw new ConfigError('Rack must be 0-7')
  if (!isInt(c.slot, 0, 31)) throw new ConfigError('Slot must be 0-31')
  if (!isInt(c.timeoutMs, 100, 10000)) throw new ConfigError('Timeout must be 100-10000 ms')
  if (!isInt(c.pollIntervalMs, 10, 2000)) throw new ConfigError('Poll interval must be 10-2000 ms')
  return c
}

function checkBit(path: string, value: unknown): S7Bit {
  if (!isObject(value)) throw new ConfigError(`${path}: must be an object`)
  if (!isInt(value.byte, 0, 65535)) throw new ConfigError(`${path}.byte: must be an integer 0-65535`)
  if (!isInt(value.bit, 0, 7)) throw new ConfigError(`${path}.bit: must be 0-7`)
  return { byte: value.byte as number, bit: value.bit as number }
}

function checkS7Command(path: string, value: unknown): S7Command {
  const bit = checkBit(path, value)
  const pulseMs = (value as Record<string, unknown>).pulseMs ?? 0
  if (!isInt(pulseMs, 0, 60000)) throw new ConfigError(`${path}.pulseMs: must be 0-60000`)
  return { ...bit, pulseMs: pulseMs as number }
}

export function validateS7Map(input: unknown): S7Map {
  if (!isObject(input)) throw new ConfigError('S7 map must be an object')
  if (!isInt(input.dbNumber, 1, 65535)) throw new ConfigError('dbNumber: must be 1-65535')
  const s = input.statusString
  if (!isObject(s) || !isInt(s.offset, 0, 65535) || !isInt(s.maxLength, 1, 254)) {
    throw new ConfigError('statusString: needs offset (0-65535) and maxLength (1-254)')
  }
  const divisor = input.loadDivisor ?? 100
  if (typeof divisor !== 'number' || !(divisor > 0)) throw new ConfigError('loadDivisor: must be > 0')
  if (!isObject(input.commands)) throw new ConfigError('commands: must be an object')
  const cmd = input.commands
  const writes = isObject(input.writes) ? input.writes : {}
  const offset = (name: string): number | null =>
    optional(writes[name], () => {
      if (!isInt(writes[name], 0, 65535)) throw new ConfigError(`writes.${name}: must be a byte offset`)
      return writes[name] as number
    })
  return {
    dbNumber: input.dbNumber as number,
    statusString: { offset: s.offset as number, maxLength: s.maxLength as number },
    loadDivisor: divisor,
    commands: {
      start: checkS7Command('commands.start', cmd.start),
      stop: checkBit('commands.stop', cmd.stop),
      reset: checkS7Command('commands.reset', cmd.reset),
      home: checkS7Command('commands.home', cmd.home)
    },
    writes: {
      upSpeed: offset('upSpeed'),
      downSpeed: offset('downSpeed'),
      jogSpeed: offset('jogSpeed'),
      distance: offset('distance')
    }
  }
}

export function validateModbusConnection(input: unknown): ModbusConnection {
  if (!isObject(input)) throw new ConfigError('Connection settings must be an object')
  const c = { ...DEFAULT_MODBUS_CONNECTION, ...input } as ModbusConnection
  if (!['rtu-serial', 'rtu-tcp', 'tcp'].includes(c.transport)) {
    throw new ConfigError('Transport must be RTU (serial), RTU over TCP, or Modbus TCP')
  }
  if (c.transport === 'rtu-serial' && !String(c.serialPath).trim()) {
    throw new ConfigError('Serial port is required for RTU (serial)')
  }
  if (c.transport !== 'rtu-serial') {
    checkHost(c.host)
    if (!isInt(c.port, 1, 65535)) throw new ConfigError('Port must be 1-65535')
  }
  if (![1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(c.baudRate)) {
    throw new ConfigError('Unsupported baud rate')
  }
  if (!['none', 'even', 'odd'].includes(c.parity)) throw new ConfigError('Parity must be none, even or odd')
  if (c.dataBits !== 7 && c.dataBits !== 8) throw new ConfigError('Data bits must be 7 or 8')
  if (c.stopBits !== 1 && c.stopBits !== 2) throw new ConfigError('Stop bits must be 1 or 2')
  if (!isInt(c.unitId, 1, 247)) throw new ConfigError('Slave ID must be 1-247')
  if (!isInt(c.timeoutMs, 100, 10000)) throw new ConfigError('Timeout must be 100-10000 ms')
  if (!isInt(c.pollIntervalMs, 20, 2000)) throw new ConfigError('Poll interval must be 20-2000 ms')
  return c
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
  if (!isInt(address, 0, 65535)) throw new ConfigError(`${path}.address: must be an integer 0-65535`)
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
  if (!isInt(address, 0, 65535)) throw new ConfigError(`${path}.address: must be an integer 0-65535`)
  if (written !== undefined && !Number.isInteger(written)) throw new ConfigError(`${path}.value: must be an integer`)
  if (pulseMs !== undefined && !isInt(pulseMs, 0, 60000)) {
    throw new ConfigError(`${path}.pulseMs: must be 0-60000`)
  }
  return value as unknown as CommandSpec
}

export function validateModbusMap(input: unknown): ModbusMap {
  if (!isObject(input)) throw new ConfigError('Register map must be a JSON object')
  const m = input
  if (!isObject(m.commands)) throw new ConfigError('commands: must be an object')
  const cmd = m.commands
  const writes = isObject(m.writes) ? m.writes : {}
  const write = (name: string): RegisterSpec | null =>
    optional(writes[name], () => checkRegister(`writes.${name}`, writes[name], { writable: true }))
  return {
    load: checkRegister('load', m.load),
    position: checkRegister('position', m.position),
    status: checkRegister('status', m.status),
    upTime: optional(m.upTime, () => checkRegister('upTime', m.upTime)),
    downTime: optional(m.downTime, () => checkRegister('downTime', m.downTime)),
    mode: optional(m.mode, () => checkRegister('mode', m.mode)),
    commands: {
      start: checkCommand('commands.start', cmd.start),
      stop: checkCommand('commands.stop', cmd.stop),
      resume: optional(cmd.resume, () => checkCommand('commands.resume', cmd.resume)),
      reset: checkCommand('commands.reset', cmd.reset),
      home: checkCommand('commands.home', cmd.home)
    },
    writes: {
      upSpeed: write('upSpeed'),
      downSpeed: write('downSpeed'),
      jogSpeed: write('jogSpeed'),
      distance: write('distance')
    }
  }
}

export function validateHardwareConfig(input: unknown): HardwareConfig {
  if (!isObject(input)) throw new ConfigError('Hardware config must be an object')
  const s7 = isObject(input.s7) ? input.s7 : {}
  const modbus = isObject(input.modbus) ? input.modbus : {}
  return {
    driver: validateDriver(input.driver),
    s7: {
      connection: validateS7Connection(s7.connection ?? {}),
      map: validateS7Map(s7.map ?? DEFAULT_S7_MAP)
    },
    modbus: {
      connection: validateModbusConnection(modbus.connection ?? {}),
      map: validateModbusMap(modbus.map ?? DEFAULT_MODBUS_MAP)
    }
  }
}
