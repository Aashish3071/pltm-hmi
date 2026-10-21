/**
 * Headless end-to-end check of the main-process stack: database seeding, auth,
 * run guard rails, the simulated run lifecycle, and report generation.
 * Run with: npm run smoke
 */
import { app } from 'electron'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HardwareStatus, type TelemetryFrame } from '@shared/types'
import { closeDb, getDb, initDb } from '../src/main/db'
import { MIGRATIONS } from '../src/main/db/schema'
import { modelsRepo, settingsRepo, testRunsRepo, usersRepo } from '../src/main/db/repositories'
import { deleteModel, renameUser, saveModel, setSpeeds } from '../src/main/services/configService'
import { getHardware, initHardware } from '../src/main/hardware/HardwareManager'
import { login } from '../src/main/services/authService'
import { generateReport, generateReportFiles } from '../src/main/services/reportService'
import { analyseRun } from '../src/main/services/testAnalysis'
import { MockHardware } from '../src/main/hardware/MockHardware'
import {
  capture as captureCalibration,
  getStatus as calibrationStatus,
  save as saveCalibration,
  setPolicy
} from '../src/main/services/calibrationService'
import {
  CommandError,
  finishRun,
  homeMachine,
  jogMachine,
  recordCycle,
  recordTelemetry,
  resetMachine,
  startRun
} from '../src/main/services/testRunService'

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
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

function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('timed out waiting for condition'))
      }
    }, 50)
  })
}

async function main(): Promise<void> {
  // Isolated throwaway profile so the smoke test never touches real app data.
  const profile = join(tmpdir(), 'pltm-smoke')
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)

  initDb()
  settingsRepo.set('report_output_dir', join(profile, 'reports'))
  console.log('\nDatabase + seeding')
  const models = modelsRepo.list()
  check('seeds 5 models', models.length === 5, `(got ${models.length})`)
  check('model has 9 points', models[0].points.length === 9)
  check('schema migrated to latest version', getDb().pragma('user_version', { simple: true }) === MIGRATIONS.length)
  check(
    'row 4 height equals distance',
    models[0].points[3].heightMm === models[0].distanceMm,
    `(${models[0].points[3].heightMm} vs ${models[0].distanceMm})`
  )

  console.log('\nAuthentication')
  check('admin logs in', login('ADMIN', 'admin')?.role === 'admin')
  check('wrong password rejected', login('ADMIN', 'nope') === null)
  check('operator logs in', login('OPERATOR1', 'operator1')?.role === 'operator')

  // Run the simulation fast so the smoke test finishes quickly.
  settingsRepo.setSpeeds({ up: 4000, down: 4000, jog: 50 })
  initHardware()
  const hardware = getHardware()

  let statusLog: HardwareStatus[] = []
  let frames: TelemetryFrame[] = []
  hardware.on('status', (status) => {
    statusLog.push(status)
    if (
      status === HardwareStatus.READY ||
      status === HardwareStatus.OVERLOAD ||
      status === HardwareStatus.EMERGENCY_PRESSED
    ) {
      finishRun(status)
    }
  })
  hardware.on('telemetry', (frame) => {
    frames.push(frame)
    recordTelemetry(frame)
  })
  hardware.on('cycle-complete', (event) => recordCycle(event.phase, event.elapsedSec))

  await hardware.connect()

  console.log('\nGuard rails')
  const request = { modelId: models[0].id, employeeUserId: 1, partNo: 'PN-001' }
  await expectError('start blocked before homing', 'ERR_NOT_HOMED', () => startRun(request))

  await hardware.setMode('MANUAL')
  await expectError('start blocked in manual mode', 'ERR_MANUAL_MODE', () => startRun(request))
  await hardware.setMode('AUTO')

  await homeMachine()
  check('homing clears HOMING NOT DONE', hardware.getSnapshot().homed)

  console.log('\nRun lifecycle')
  statusLog = []
  frames = []
  await startRun(request)
  check('status goes to PANTO RAISING', hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING)

  await waitFor(() => statusLog.includes(HardwareStatus.PANTO_RAISING_COMPLETED))
  check('raising completes', true)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY)
  check('retrieves back to READY', statusLog.includes(HardwareStatus.PANTO_RETRIEVING))

  const peak = Math.max(...frames.map((f) => f.heightMm))
  check(
    'reaches configured travel distance',
    Math.abs(peak - models[0].distanceMm) < 1,
    `(peak ${peak} vs ${models[0].distanceMm})`
  )
  const loads = frames.filter((f) => f.phase !== 'idle').map((f) => f.loadN)
  check('load tracks the envelope', Math.min(...loads) > 40 && Math.max(...loads) < 120,
    `(min ${Math.min(...loads).toFixed(1)}, max ${Math.max(...loads).toFixed(1)})`)

  const run = testRunsRepo.lastCompleted()
  check('run persisted and closed', !!run && run.endedAt !== null)
  check('run points persisted', run ? testRunsRepo.points(run.id).length > 10 : false)
  check('up and down cycle times recorded', !!run && run.upCycleSec! > 0 && run.downCycleSec! > 0)

  console.log('\nReset requirement')
  await expectError('start blocked without reset', 'ERR_RESET_REQUIRED', () => startRun(request))
  await resetMachine()
  await startRun(request)
  check('start allowed after reset', hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING)
  await hardware.stop()
  check('stop halts the run', hardware.getSnapshot().status === HardwareStatus.HALT)

  const heightAtStop = hardware.getSnapshot().heightMm
  frames = []
  await new Promise((r) => setTimeout(r, 600))
  const heightAfterStop = hardware.getSnapshot().heightMm
  check(
    'pantograph stops moving while halted',
    Math.abs(heightAfterStop - heightAtStop) < 0.5,
    `(${heightAtStop} -> ${heightAfterStop})`
  )
  check(
    'no run points recorded while halted',
    frames.every((f) => f.phase === 'idle'),
    `(phases: ${[...new Set(frames.map((f) => f.phase))].join(',')})`
  )

  await startRun(request)
  check('resume from HALT works without reset', hardware.getSnapshot().status !== HardwareStatus.HALT)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY)

  console.log('\nFault handling')
  await resetMachine()
  await hardware.forceFault!('OVERLOAD')
  check('overload raises OVERLOAD', hardware.getSnapshot().status === HardwareStatus.OVERLOAD)
  await expectError('start blocked during fault', 'ERR_FAULT_ACTIVE', () => startRun(request))
  await resetMachine()
  await hardware.forceFault('DISCONNECT')
  check('disconnect drops connection', !hardware.getSnapshot().connected)
  await expectError('start blocked while disconnected', 'ERR_HARDWARE_DISCONNECTED', () =>
    startRun(request)
  )
  check('reconnect fails during simulated outage', !(await hardware.tryConnect()))
  await new Promise((r) => setTimeout(r, 5200))
  check('reconnects once the outage ends', await hardware.tryConnect())

  console.log('\nHoming guards (regressions)')
  await resetMachine()
  await homeMachine()
  await startRun(request)
  await expectError('HOMING blocked while running', 'ERR_HOMING_BLOCKED', () => homeMachine())
  check('run not closed by blocked HOMING', hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING)
  await waitFor(() => hardware.getSnapshot().heightMm > 1)
  await hardware.stop()
  await expectError('HOMING blocked while paused', 'ERR_HOMING_BLOCKED', () => homeMachine())
  await resetMachine()
  check('RESET mid-test aborts the run', testRunsRepo.lastCompleted()?.resultStatus === 'ABORTED')
  check('RESET away from zero requires homing', hardware.getSnapshot().status === HardwareStatus.HOMING_NOT_DONE)
  await homeMachine()
  await hardware.forceFault('EMERGENCY')
  await expectError('HOMING cannot clear an EMERGENCY', 'ERR_FAULT_ACTIVE', () => homeMachine())
  check('EMERGENCY still active', hardware.getSnapshot().status === HardwareStatus.EMERGENCY_PRESSED)
  await resetMachine()
  await homeMachine()

  console.log('\nRun input validation')
  await expectError('Part-No is required', 'ERR_INVALID_INPUT', () => startRun({ ...request, partNo: '  ' }))
  await expectError('unknown employee rejected', 'ERR_INVALID_INPUT', () =>
    startRun({ ...request, employeeUserId: 999 })
  )

  console.log('\nResume keeps its model')
  await startRun(request)
  await hardware.stop()
  await startRun({ ...request, modelId: models[1].id })
  check('resume ignores a different selected model', hardware.getSnapshot().activeModelId === models[0].id)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY)

  console.log('\nCycle timers')
  await resetMachine()
  frames = []
  await startRun(request)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY)
  check('telemetry carries live up timer', frames.some((f) => f.phase === 'up' && f.upCycleSec > 0))
  check('telemetry carries live down timer', frames.some((f) => f.phase === 'down' && f.downCycleSec > 0))

  console.log('\nManual jog')
  await resetMachine()
  await expectError('jog refused in AUTO mode', 'ERR_INVALID_INPUT', () => jogMachine('UP', true))
  await hardware.setMode('MANUAL')
  hardware.startSupervision()
  await jogMachine('UP', true)
  await new Promise((r) => setTimeout(r, 300))
  check('jog moves the arm', hardware.getSnapshot().heightMm > 0)
  check('moving off zero clears homing', !hardware.getSnapshot().homed)
  await new Promise((r) => setTimeout(r, 900))
  const parked = hardware.getSnapshot().heightMm
  await new Promise((r) => setTimeout(r, 300))
  check('watchdog stops jog without keep-alive', hardware.getSnapshot().heightMm === parked)
  await hardware.forceFault('EMERGENCY')
  await expectError('jog refused during EMERGENCY', 'ERR_FAULT_ACTIVE', () => jogMachine('UP', true))
  hardware.stopSupervision()
  await resetMachine()
  await hardware.setMode('AUTO')
  await homeMachine()

  console.log('\nAdmin validation')
  const nine = models[0].points
  await expectError('duplicate model name rejected', 'ERR_DUPLICATE_NAME', async () =>
    saveModel({ name: models[1].name.toLowerCase(), distanceMm: 0, points: nine })
  )
  await expectError('zero travel distance rejected', 'ERR_INVALID_INPUT', async () =>
    saveModel({ name: 'BAD', distanceMm: 0, points: nine.map((p) => ({ ...p, heightMm: 0 })) })
  )
  await expectError('height above capacity rejected', 'ERR_INVALID_INPUT', async () =>
    saveModel({ name: 'TALL', distanceMm: 0, points: nine.map((p) => ({ ...p, heightMm: 9999 })) })
  )
  const created = saveModel({ name: 'TEST MODEL', distanceMm: 0, points: nine })
  const testModel = created.find((m) => m.name === 'TEST MODEL')
  check('new model created with row-4 distance', testModel?.distanceMm === nine[3].heightMm)
  await resetMachine()
  await startRun({ ...request, modelId: testModel!.id })
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY)
  const testRun = testRunsRepo.lastCompleted()!
  const afterDelete = deleteModel(testModel!.id)
  check('deleted model leaves the list', !afterDelete.some((m) => m.id === testModel!.id))
  check('past run still resolves its model', (testRunsRepo.get(testRun.id)?.modelName ?? '').startsWith('TEST MODEL'))
  check('name is reusable after delete', saveModel({ name: 'TEST MODEL', distanceMm: 0, points: nine }).some((m) => m.name === 'TEST MODEL'))
  await expectError('duplicate user name rejected', 'ERR_DUPLICATE_NAME', async () =>
    renameUser(usersRepo.list()[1].id, 'operator3')
  )
  await expectError('speed above limit rejected', 'ERR_INVALID_INPUT', () => setSpeeds({ up: 9000, down: 50, jog: 50 }))
  await expectError('zero speed rejected', 'ERR_INVALID_INPUT', () => setSpeeds({ up: 0, down: 50, jog: 50 }))

  console.log('\nReporting')
  const completed = testRunsRepo.lastCompleted()
  const path = await generateReport(completed!.id)
  const { existsSync, statSync } = await import('fs')
  check('report file written', existsSync(path))
  check('report is non-trivial', existsSync(path) && statSync(path).size > 4000)
  console.log(`        -> ${path}`)

  console.log('\nRun analysis')
  const synthetic = [
    ...Array.from({ length: 50 }, (_, i) => ({ loadN: 60, heightMm: 100 + i * 40, phase: 'up' })),
    ...Array.from({ length: 50 }, (_, i) => ({ loadN: 70, heightMm: 2060 - i * 40, phase: 'down' }))
  ]
  const analysis = analyseRun(synthetic)
  check('mean static force is (Fr + Fl) / 2', analysis.meanStaticN === 65, `(${analysis.meanStaticN})`)
  check('hysteresis is Fl − Fr', analysis.maxHysteresisN === 10, `(${analysis.maxHysteresisN})`)
  const sparse = analyseRun([
    { loadN: 60, heightMm: 0, phase: 'up' }, { loadN: 60, heightMm: 1000, phase: 'up' }, { loadN: 60, heightMm: 2000, phase: 'up' },
    { loadN: 70, heightMm: 2000, phase: 'down' }, { loadN: 70, heightMm: 1000, phase: 'down' }, { loadN: 70, heightMm: 0, phase: 'down' }
  ])
  check('sparse readings are interpolated, not left blank', sparse.rows.every((r) => r.meanN === 65), JSON.stringify(sparse.rows.map((r) => r.meanN)))
  check('turnarounds excluded from the evaluated band', analysis.fromMm > 100 && analysis.toMm < 2060, `(${analysis.fromMm}-${analysis.toMm})`)
  check('ten height rows reported', analysis.rows.length === 10 && analysis.rows.every((r) => r.meanN === 65))

  console.log('\nCalibration on the simulator')
  // A simulated load cell that reads 4% high with a 2 N offset.
  const sensorError = { gain: 1.04, offset: 2 }
  await hardware.setDriver(new MockHardware({ sensorError, speeds: settingsRepo.getSpeeds() }), 'simulator')
  await waitFor(() => hardware.getSnapshot().connected)
  setPolicy({ enforcement: 'block', intervalMonths: 12, maxPermissibleErrorN: 1 })
  check('calibration rules are not enforced on the simulator', !calibrationStatus().applies && !calibrationStatus().blocking)
  const simPoints: { referenceN: number; rawN: number }[] = []
  for (const referenceN of [0, 49.033, 98.066]) {
    hardware.setSimulatedReferenceLoad(referenceN)
    await new Promise((r) => setTimeout(r, 300))
    const reading = await captureCalibration(800)
    simPoints.push({ referenceN, rawN: reading.rawN })
  }
  const simCal = saveCalibration({ points: simPoints, referenceDevice: 'Sim weights', referenceCertificateNo: '', notes: '' }, 'ADMIN')
  check('calibration fit passes', simCal.passed, `(max error ${simCal.maxErrorN} N)`)
  check('fit recovers the simulated sensor error', Math.abs(simCal.gain - 1.04) < 0.005 && Math.abs(simCal.offset - 2) < 0.1, `(gain ${simCal.gain}, offset ${simCal.offset})`)
  hardware.setSimulatedReferenceLoad(68.6)
  await new Promise((r) => setTimeout(r, 300))
  check('readings are corrected', Math.abs(hardware.getSnapshot().loadN - 68.6) < 0.15, `(${hardware.getSnapshot().loadN} N vs raw ${hardware.getSnapshot().loadRawN} N)`)
  await hardware.setDriver(new MockHardware({ sensorError, speeds: settingsRepo.getSpeeds() }), 'simulator')
  await waitFor(() => hardware.getSnapshot().connected)
  hardware.setSimulatedReferenceLoad(68.6)
  await new Promise((r) => setTimeout(r, 300))
  check('calibration survives a driver change', Math.abs(hardware.getSnapshot().loadN - 68.6) < 0.15, `(${hardware.getSnapshot().loadN} N)`)
  hardware.setSimulatedReferenceLoad(null)
  setPolicy({ enforcement: 'warn', intervalMonths: 12, maxPermissibleErrorN: 1 })

  console.log('\nTest certificate (PDF)')
  const { readFileSync } = await import('fs')
  const certRun = testRunsRepo.lastCompleted()!
  const files = await generateReportFiles(certRun.id)
  check('certificate number allocated', /^PLTM-0001\/\d{4}\/00001$/.test(files.certificateNo), `(${files.certificateNo})`)
  check('Excel report written', existsSync(files.excelPath))
  check('PDF certificate written', existsSync(files.pdfPath) && readFileSync(files.pdfPath).subarray(0, 5).toString() === '%PDF-')
  check('PDF is a full document', existsSync(files.pdfPath) && statSync(files.pdfPath).size > 20000, `(${existsSync(files.pdfPath) ? statSync(files.pdfPath).size : 0} bytes)`)
  const again = await generateReportFiles(certRun.id)
  check('a run keeps its certificate number', again.certificateNo === files.certificateNo)
  await homeMachine()
  await resetMachine()
  await homeMachine()
  await startRun(request)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY)
  const nextRun = testRunsRepo.lastCompleted()!
  const nextFiles = await generateReportFiles(nextRun.id)
  check('the next run gets the next number', nextFiles.certificateNo.endsWith('/00002'), `(${nextFiles.certificateNo})`)
  console.log(`        -> ${files.pdfPath}`)

  console.log('\nCrash recovery')
  testRunsRepo.create({ employeeUserId: 1, modelId: models[0].id, partNo: 'ORPHAN' })
  closeDb()
  initDb()
  const orphan = getDb().prepare("SELECT result_status FROM test_runs WHERE part_no = 'ORPHAN'").get() as { result_status: string }
  check('run left open by a crash is closed as ABORTED', orphan?.result_status === 'ABORTED')

  closeDb()
  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
  app.exit(failures === 0 ? 0 : 1)
}

// The certificate renderer opens and closes a hidden window; with no other
// window open Electron would otherwise quit when it closes.
app.on('window-all-closed', () => undefined)

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error)
    app.exit(1)
  })
)
