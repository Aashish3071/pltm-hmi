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
import { calibrationsRepo, modelsRepo, settingsRepo, testRunsRepo } from '../src/main/db/repositories'
import { DEFAULT_CONNECTION, DEFAULT_REGISTER_MAP } from '../src/main/hardware/config'
import { getHardware, initHardware } from '../src/main/hardware/HardwareManager'
import { decode, encode, planReads } from '../src/main/hardware/modbusCodec'
import {
  capture as captureCalibration,
  save as saveCalibration,
  saveCertificate,
  setPolicy,
  today
} from '../src/main/services/calibrationService'
import {
  setHardwareConfig,
  setMachineSettings,
  testHardwareConfig
} from '../src/main/services/configService'
import {
  CommandError,
  finishRun,
  getActiveRunId,
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
      [
        HardwareStatus.READY,
        HardwareStatus.OVERLOAD,
        HardwareStatus.EMERGENCY_PRESSED,
        HardwareStatus.OVER_TRAVEL,
        HardwareStatus.DISCONNECTED
      ].includes(status)
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

  console.log('\nSafety set-points and watchdog feed')
  check('overload limit written to PLC on connect (250 N -> raw 2500)', await waitFor(() => plc.holding[4] === 2500, 2000), `(${plc.holding[4]})`)
  check('travel limit written to PLC on connect (4000 mm)', plc.holding[5] === 4000, `(${plc.holding[5]})`)
  const beatBefore = plc.heartbeat
  await sleep(1200)
  check('app feeds the PLC watchdog', plc.heartbeat !== beatBefore, `(${beatBefore} -> ${plc.heartbeat})`)
  check('snapshot reports the watchdog as fed', hardware.getSnapshot().safety.heartbeat === true)
  check('safety signals read from the PLC', hardware.getSnapshot().safety.estop === false && hardware.getSnapshot().safety.overloadTrip === false)
  const machine = { machineId: 'PLTM-0001', companyName: 'Novatek', companyAddress: '' }
  await setMachineSettings({ ...machine, loadCapacityN: 200, heightCapacityMm: 3900 })
  check('changing capacities updates the PLC limits', plc.holding[4] === 2000 && plc.holding[5] === 3900, `(${plc.holding[4]}, ${plc.holding[5]})`)
  await setMachineSettings({ ...machine, loadCapacityN: 250, heightCapacityMm: 4000 })

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

  console.log('\nPLC overload trip')
  await resetMachine()
  await startRun(request)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING, 2000)
  plc.loadOverrideN = 300
  check('PLC trips by itself at its overload limit', await waitFor(() => plc.lastSafetyStop === 'overload', 2000), `(${plc.lastSafetyStop})`)
  check('app shows OVERLOAD from the PLC flag', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.OVERLOAD, 3000))
  check('overload flag visible in safety state', hardware.getSnapshot().safety.overloadTrip === true)
  check('run closed as OVERLOAD', testRunsRepo.lastCompleted()?.resultStatus === HardwareStatus.OVERLOAD)
  await expectError('start blocked while overloaded', 'ERR_FAULT_ACTIVE', () => startRun(request))
  await resetMachine()
  check('RESET clears overload', await waitFor(() => hardware.getSnapshot().status !== HardwareStatus.OVERLOAD, 2000))

  console.log('\nHard-wired E-stop')
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 2000)
  await startRun(request)
  await waitFor(() => hardware.getSnapshot().heightMm > 200, 5000)
  plc.estopPressed = true
  check('E-stop shown at once', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.EMERGENCY_PRESSED, 1000))
  check('E-stop visible in safety state', hardware.getSnapshot().safety.estop === true)
  const stoppedAt = plc.positionMm
  await sleep(400)
  check('machine does not move while E-stop is pressed', Math.abs(plc.positionMm - stoppedAt) < 0.01)
  check('run closed as EMERGENCY PRESSED', testRunsRepo.lastCompleted()?.resultStatus === HardwareStatus.EMERGENCY_PRESSED)
  await expectError('START refused during E-stop', 'ERR_FAULT_ACTIVE', () => startRun(request))
  await resetMachine()
  await sleep(300)
  check('RESET cannot clear a pressed E-stop', hardware.getSnapshot().status === HardwareStatus.EMERGENCY_PRESSED)
  plc.estopPressed = false
  await sleep(400)
  check('releasing the E-stop does not restart anything', hardware.getSnapshot().status === HardwareStatus.EMERGENCY_PRESSED && Math.abs(plc.positionMm - stoppedAt) < 0.01)
  await resetMachine()
  check('release + RESET recovers', await waitFor(() => hardware.getSnapshot().status !== HardwareStatus.EMERGENCY_PRESSED, 2000))

  console.log('\nOver-travel limit')
  await homeMachine()
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 2000)
  await hardware.setHeightCapacity(600)
  plc.manualMode = true
  await waitFor(() => hardware.getSnapshot().mode === 'MANUAL', 2000)
  await jogMachine('UP', true)
  const holdUp = setInterval(() => void jogMachine('UP', true), 200)
  const tripped = await waitFor(() => hardware.getSnapshot().status === HardwareStatus.OVER_TRAVEL, 4000)
  clearInterval(holdUp)
  await jogMachine('UP', false).catch(() => undefined)
  check('jogging into the limit trips OVER TRAVEL', tripped, `(${hardware.getSnapshot().status})`)
  check('PLC stopped at its travel limit', plc.lastSafetyStop === 'travel' && plc.positionMm <= 600.01, `(${plc.positionMm})`)
  check('limit visible in safety state', hardware.getSnapshot().safety.upperLimit === true)
  await hardware.setHeightCapacity(4000)
  await resetMachine()
  check('RESET clears the over-travel', await waitFor(() => hardware.getSnapshot().status !== HardwareStatus.OVER_TRAVEL, 2000))
  plc.manualMode = false
  await waitFor(() => hardware.getSnapshot().mode === 'AUTO', 2000)
  await homeMachine()

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
  const silentAt = Date.now()
  check('link loss detected', await waitFor(() => !hardware.getSnapshot().connected, 5000))
  check('PLC watchdog halts the machine when the app goes silent', await waitFor(() => plc.lastSafetyStop === 'watchdog' && plc.status === STATUS.HALT, 4000), `(${plc.lastSafetyStop}, status ${plc.status}, ${Date.now() - silentAt} ms)`)
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

  console.log('\nLoad-cell calibration and enforcement')
  await resetMachine()
  await homeMachine()
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 2000)
  settingsRepo.setSpeeds({ up: 2000, down: 2000, jog: 1000 })
  await hardware.setSpeeds({ up: 2000, down: 2000, jog: 1000 })
  setPolicy({ enforcement: 'block', intervalMonths: 12, maxPermissibleErrorN: 1 })
  await expectError('tests blocked when never calibrated', 'ERR_CALIBRATION_REQUIRED', () => startRun(request))
  // The simulated load cell reads 3% high with a 1.2 N offset.
  const sensor = (trueN: number): number => trueN * 1.03 + 1.2
  const calPoints: { referenceN: number; rawN: number }[] = []
  let allStable = true
  for (const trueN of [0, 49.033, 98.066]) {
    plc.loadOverrideN = sensor(trueN)
    await sleep(300)
    const reading = await captureCalibration(800)
    allStable = allStable && reading.stable
    calPoints.push({ referenceN: trueN, rawN: reading.rawN })
  }
  check('captured readings are steady', allStable)
  const calibration = saveCalibration({ points: calPoints, referenceDevice: 'M1 weights', referenceCertificateNo: 'W-001', notes: '' }, 'ADMIN')
  check('calibration passes and is saved', calibration.passed && calibrationsRepo.active()?.id === calibration.id)
  check('fit recovers the sensor error', Math.abs(calibration.gain - 1 / 1.03) < 0.001 && Math.abs(calibration.offset - -1.2 / 1.03) < 0.05, `(gain ${calibration.gain}, offset ${calibration.offset})`)
  plc.loadOverrideN = sensor(68.6)
  await sleep(400)
  check('live load is corrected after calibration', Math.abs(hardware.getSnapshot().loadN - 68.6) < 0.05, `(${hardware.getSnapshot().loadN} N, raw ${hardware.getSnapshot().loadRawN} N)`)
  plc.loadOverrideN = null
  await expectError('still blocked without an accredited certificate', 'ERR_CALIBRATION_REQUIRED', () => startRun(request))
  const nextYear = `${Number(today().slice(0, 4)) + 1}${today().slice(4)}`
  saveCertificate({ labName: 'Test Lab', accreditationNo: 'CC-1234', certificateNo: 'LC-2026-001', loadCellSerial: 'LC1', calibratedOn: today(), validUntil: nextYear, uncertainty: '0.1 %' })
  await startRun(request)
  const trace = testRunsRepo.traceability(getActiveRunId()!)
  check('test allowed once calibrated and certified', hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING || hardware.getSnapshot().status === HardwareStatus.PANTO_RETRIEVING)
  check('run records its calibration and certificate', trace.calibrationId === calibration.id && trace.loadCellCertificateId !== null)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 15000)
  const bad = saveCalibration({ points: [{ referenceN: 0, rawN: 0 }, { referenceN: 50, rawN: 60 }, { referenceN: 100, rawN: 100 }], referenceDevice: '', referenceCertificateNo: '', notes: '' }, 'ADMIN')
  check('a failed calibration is recorded but not applied', !bad.passed && calibrationsRepo.active()?.id === calibration.id)
  setPolicy({ enforcement: 'warn', intervalMonths: 12, maxPermissibleErrorN: 1 })

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
