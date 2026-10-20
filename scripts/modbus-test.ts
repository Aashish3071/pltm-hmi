/**
 * End-to-end test of the Modbus driver against a fake PLC over real sockets:
 * RTU framing (CRC) over TCP and Modbus TCP. Exercises the same services the
 * UI calls. Run with: npm run test:modbus
 */
import { app } from 'electron'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HardwareStatus, type HardwareConfig } from '@shared/types'
import { closeDb, initDb } from '../src/main/db'
import { modelsRepo, settingsRepo, testRunsRepo } from '../src/main/db/repositories'
import { DEFAULT_CONNECTION, DEFAULT_REGISTER_MAP } from '../src/main/hardware/config'
import { getHardware, initHardware } from '../src/main/hardware/HardwareManager'
import { decode, encode, planReads } from '../src/main/hardware/modbusCodec'
import { setHardwareConfig, testHardwareConfig } from '../src/main/services/configService'
import {
  CommandError,
  finishRun,
  homeMachine,
  jogMachine,
  recordCycle,
  recordTelemetry,
  resetMachine,
  setMachineMode,
  startRun,
  stopRun
} from '../src/main/services/testRunService'
import { crc16, FakePlc, STATUS } from './fakePlc'

const RTU_PORT = 15020
const TCP_PORT = 15021

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

async function expectError(label: string, code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    check(label, false, '(no error thrown)')
  } catch (error) {
    const actual = error instanceof CommandError ? error.code : String(error)
    check(label, actual === code, `(got ${actual})`)
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 25)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function codecChecks(): void {
  console.log('\nCodec')
  check('CRC-16/Modbus of 01 03 00 00 00 0A is 0xCDC5', crc16(Buffer.from([1, 3, 0, 0, 0, 10])) === 0xcdc5)
  const int32 = { area: 'input' as const, address: 0, dataType: 'int32' as const, wordOrder: 'BE' as const, scale: 0.01 }
  check('int32 BE round-trips a negative value', decode(int32, encode(int32, -1234.56)) === -1234.56)
  const le = { ...int32, wordOrder: 'LE' as const }
  check('int32 LE swaps words', encode(le, 1)[1] === encode(int32, 1)[0])
  const f32 = { area: 'holding' as const, address: 0, dataType: 'float32' as const }
  check('float32 round-trips', Math.abs(decode(f32, encode(f32, 3.25)) - 3.25) < 1e-6)
  check('int16 sign-extends', decode({ area: 'input', address: 0, dataType: 'int16' }, [0xffff]) === -1)
  check('uint16 write clamps to range', encode({ area: 'holding', address: 0 }, 70000)[0] === 0xffff)
  const blocks = planReads([
    DEFAULT_REGISTER_MAP.load,
    DEFAULT_REGISTER_MAP.position,
    DEFAULT_REGISTER_MAP.status,
    DEFAULT_REGISTER_MAP.mode!,
    DEFAULT_REGISTER_MAP.homed!
  ])
  check('poll plan merges into one request per area', blocks.length === 2, `(${JSON.stringify(blocks)})`)
}

async function main(): Promise<void> {
  codecChecks()

  const profile = join(tmpdir(), 'pltm-modbus-test')
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  initDb()
  settingsRepo.setSpeeds({ up: 2000, down: 2000, jog: 1000 })

  const plc = new FakePlc()
  await plc.listenRtuOverTcp(RTU_PORT)
  await plc.listenTcp(TCP_PORT)

  const hardware = initHardware()
  const statusLog: HardwareStatus[] = []
  const cycles: string[] = []
  hardware.on('status', (status) => {
    statusLog.push(status)
    if (
      [HardwareStatus.READY, HardwareStatus.OVERLOAD, HardwareStatus.DISCONNECTED].includes(status)
    ) {
      finishRun(status)
    }
  })
  hardware.on('telemetry', (frame) => recordTelemetry(frame))
  hardware.on('cycle-complete', (event) => {
    cycles.push(event.phase)
    recordCycle(event.phase, event.elapsedSec)
  })

  const rtuConfig: HardwareConfig = {
    driver: 'modbus',
    connection: { ...DEFAULT_CONNECTION, transport: 'rtu-tcp', host: '127.0.0.1', port: RTU_PORT, pollIntervalMs: 50, timeoutMs: 500 },
    registerMap: DEFAULT_REGISTER_MAP
  }

  console.log('\nConnection test (read-only probe)')
  const writesBefore = plc.writes
  const probe = await testHardwareConfig(rtuConfig)
  check('probe reads machine status', probe.status === HardwareStatus.HOMING_NOT_DONE, `(${probe.status})`)
  check('probe writes nothing to the PLC', plc.writes === writesBefore, `(${plc.writes - writesBefore} writes)`)

  console.log('\nRTU over TCP — connect')
  await setHardwareConfig(rtuConfig)
  check('driver switched to modbus', hardware.driverKind === 'modbus')
  check('connected over RTU framing', await waitFor(() => hardware.getSnapshot().connected, 5000))
  check('reports HOMING NOT DONE from PLC', hardware.getSnapshot().status === HardwareStatus.HOMING_NOT_DONE)
  check('speeds written on connect (2000 mm/s -> raw 20000)', await waitFor(() => plc.holding[0] === 20000, 2000), `(${plc.holding[0]})`)
  hardware.startSupervision()

  const model = modelsRepo.list()[0]
  const request = { modelId: model.id, employeeUserId: 1, partNo: 'MB-001' }

  console.log('\nGuards and homing')
  await expectError('start blocked before homing', 'ERR_NOT_HOMED', () => startRun(request))
  await homeMachine()
  check('home command reaches READY', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 3000))
  check('homed bit read from PLC', hardware.getSnapshot().homed)
  check('home coil pulsed back to 0', await waitFor(() => plc.coils[3] === 0, 2000))

  console.log('\nFull test cycle')
  statusLog.length = 0
  cycles.length = 0
  await startRun(request)
  check('travel distance written before START', plc.travelMm === model.distanceMm, `(${plc.travelMm})`)
  check('PLC raises', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING, 2000))
  check('cycle returns to READY', await waitFor(() => statusLog.includes(HardwareStatus.PANTO_RETRIEVING) && hardware.getSnapshot().status === HardwareStatus.READY, 15000))
  check('up and down cycle-complete events', cycles.includes('up') && cycles.includes('down'), `(${cycles.join(',')})`)
  const run = testRunsRepo.lastCompleted()
  check('run recorded as COMPLETED', run?.resultStatus === 'COMPLETED', `(${run?.resultStatus})`)
  check('run has telemetry points', run ? testRunsRepo.points(run.id).length > 5 : false)
  check('cycle times recorded', !!run && (run.upCycleSec ?? 0) > 0 && (run.downCycleSec ?? 0) > 0)
  await expectError('second start needs RESET', 'ERR_RESET_REQUIRED', () => startRun(request))

  console.log('\nStop and resume')
  await resetMachine()
  settingsRepo.setSpeeds({ up: 400, down: 2000, jog: 1000 })
  await hardware.setSpeeds({ up: 400, down: 2000, jog: 1000 })
  await startRun(request)
  await waitFor(() => hardware.getSnapshot().heightMm > 300, 5000)
  await stopRun()
  check('STOP halts the PLC', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.HALT, 2000))
  const heldAt = plc.positionMm
  await sleep(400)
  check('position holds while halted', Math.abs(plc.positionMm - heldAt) < 0.01)
  await startRun({ ...request, modelId: modelsRepo.list()[1].id })
  check('RESUME continues raising', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING, 2000))
  check('resume keeps the paused run model', hardware.getSnapshot().activeModelId === model.id)
  check('resumed run completes', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 20000))

  console.log('\nSoftware overload trip')
  await resetMachine()
  await startRun(request)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING, 2000)
  plc.loadOverrideN = 300
  check('app trips OVERLOAD above capacity', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.OVERLOAD, 3000))
  check('PLC was commanded to stop', await waitFor(() => plc.status === STATUS.HALT, 2000), `(PLC status ${plc.status})`)
  check('run closed as OVERLOAD', testRunsRepo.lastCompleted()?.resultStatus === HardwareStatus.OVERLOAD)
  await expectError('start blocked while overloaded', 'ERR_FAULT_ACTIVE', () => startRun(request))
  await resetMachine()
  check('RESET clears overload', await waitFor(() => hardware.getSnapshot().status !== HardwareStatus.OVERLOAD, 2000))

  console.log('\nManual mode and jog watchdog')
  await expectError('mode change routed to pendant', 'ERR_INVALID_INPUT', () => setMachineMode('MANUAL'))
  plc.manualMode = true
  check('MANUAL mode read from PLC', await waitFor(() => hardware.getSnapshot().mode === 'MANUAL', 2000))
  await jogMachine('UP', true)
  check('jog UP coil set', await waitFor(() => plc.coils[4] === 1, 1000))
  check('watchdog releases jog without keep-alive', await waitFor(() => plc.coils[4] === 0, 2000))
  await jogMachine('UP', true)
  const keepAlive = setInterval(() => void jogMachine('UP', true), 200)
  await sleep(1000)
  check('keep-alive holds jog', plc.coils[4] === 1)
  clearInterval(keepAlive)
  await jogMachine('UP', false)
  check('release clears jog coil', await waitFor(() => plc.coils[4] === 0, 1000))
  plc.manualMode = false
  await waitFor(() => hardware.getSnapshot().mode === 'AUTO', 2000)

  console.log('\nLink loss and recovery')
  await homeMachine()
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 2000)
  await resetMachine()
  settingsRepo.setSpeeds({ up: 200, down: 200, jog: 1000 })
  await hardware.setSpeeds({ up: 200, down: 200, jog: 1000 })
  await startRun(request)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING, 2000)
  await plc.closeServers()
  check('link loss detected', await waitFor(() => !hardware.getSnapshot().connected, 5000))
  check('status shows DISCONNECTED', hardware.getSnapshot().status === HardwareStatus.DISCONNECTED)
  check('in-progress run closed', testRunsRepo.lastCompleted()?.resultStatus === HardwareStatus.DISCONNECTED, `(${testRunsRepo.lastCompleted()?.resultStatus})`)
  await expectError('commands refused while disconnected', 'ERR_HARDWARE_DISCONNECTED', () => homeMachine())
  await plc.listenRtuOverTcp(RTU_PORT)
  await plc.listenTcp(TCP_PORT)
  check('supervisor reconnects automatically', await waitFor(() => hardware.getSnapshot().connected, 8000))

  console.log('\nGateway connection reset (RST)')
  await resetMachine()
  check('connected before reset', await waitFor(() => hardware.getSnapshot().connected, 5000))
  const resetAt = Date.now()
  plc.resetConnections()
  check('hard reset detected within 3 s', await waitFor(() => !hardware.getSnapshot().connected, 3000), `(${Date.now() - resetAt} ms)`)
  check('reconnects after a hard reset', await waitFor(() => hardware.getSnapshot().connected, 8000))

  console.log('\nModbus TCP transport')
  await resetMachine()
  await setHardwareConfig({
    ...rtuConfig,
    connection: { ...rtuConfig.connection, transport: 'tcp', port: TCP_PORT }
  })
  check('connected over Modbus TCP', await waitFor(() => hardware.getSnapshot().connected, 5000))
  check('reads live status over TCP', hardware.getSnapshot().status !== HardwareStatus.DISCONNECTED)

  console.log('\nBad configuration')
  await expectError('unreachable port fails cleanly', 'ERR_CONNECTION_FAILED', () =>
    testHardwareConfig({ ...rtuConfig, connection: { ...rtuConfig.connection, port: 15999 } })
  )
  await expectError('wrong slave ID times out cleanly', 'ERR_CONNECTION_FAILED', () =>
    testHardwareConfig({ ...rtuConfig, connection: { ...rtuConfig.connection, unitId: 9 } })
  )
  await expectError('invalid register map rejected', 'ERR_INVALID_INPUT', () =>
    testHardwareConfig({ ...rtuConfig, registerMap: { ...DEFAULT_REGISTER_MAP, load: { area: 'nope', address: -1 } } as never })
  )

  hardware.stopSupervision()
  await hardware.disconnect()
  await plc.shutdown()
  closeDb()
  console.log(failures === 0 ? '\nAll Modbus checks passed.\n' : `\n${failures} Modbus check(s) failed.\n`)
  app.exit(failures === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error)
    app.exit(1)
  })
)
