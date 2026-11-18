/**
 * Integration test of everything below the UI, inside Electron (for the
 * database, PDF printing and app paths):
 *  - the result maths: the 70-sample zero-phase filter (checked against
 *    reference values) and the test results;
 *  - the Siemens S7 driver against a fake S7 PLC over a real socket: speeds,
 *    homing, a full START cycle, STOP/resume, RESET history rotation,
 *    reconnection after a pulled cable, PUT/GET refused;
 *  - the Modbus driver (RTU over TCP and Modbus TCP) against a fake PLC;
 *  - the simulator's faults;
 *  - the Excel, PDF and JSON reports.
 * Run with: npm run test:machine
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import ExcelJS from 'exceljs'
import { StatusCode, type HardwareConfig, type Sample } from '@shared/types'
import { computeResults, filtfiltMovingAverage } from '@shared/analysis'
import { closeDb, initDb } from '../src/main/db'
import { modelsRepo, settingsRepo, testRunsRepo } from '../src/main/db/repositories'
import { DEFAULT_HARDWARE_CONFIG } from '../src/main/hardware/config'
import { getHardware, initHardware } from '../src/main/hardware/HardwareManager'
import { parseStatusString } from '../src/main/hardware/HardwareInterface'
import * as auth from '../src/main/services/authService'
import * as config from '../src/main/services/configService'
import { generateReport } from '../src/main/services/reportService'
import * as tests from '../src/main/services/testService'
import { FakeS7Plc } from './fakeS7'
import { FakePlc } from './fakePlc'

const root = resolve(__dirname, '..', '..')
const work = join(tmpdir(), `pltm-machine-test-${process.pid}`)
let failures = 0

function check(label: string, condition: boolean, detail: unknown = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(what: () => boolean, timeoutMs = 15000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (what()) return true
    await sleep(20)
  }
  return what()
}

function code(): number {
  const s = getHardware().getState()
  return s.connected ? s.code : 100
}

/** Records every distinct status the app saw, in order. */
function watchCodes(): { codes: number[]; stop: () => void } {
  const codes: number[] = []
  const listener = (s: { connected: boolean; code: number }): void => {
    const c = s.connected ? s.code : 100
    if (codes[codes.length - 1] !== c) codes.push(c)
  }
  getHardware().on('state', listener)
  return { codes, stop: () => getHardware().off('state', listener) }
}

async function runCycle(label: string): Promise<number[]> {
  const watch = watchCodes()
  await tests.start()
  const done = await waitFor(() => watch.codes.includes(StatusCode.CYCLE_COMPLETED), 30000)
  await waitFor(() => code() === StatusCode.READY, 5000)
  watch.stop()
  check(`${label}: cycle completes`, done, watch.codes)
  return watch.codes
}

async function analysisTests(): Promise<void> {
  console.log('\nResult maths')
  const x = Array.from({ length: 300 }, (_, i) => Math.sin(i / 10) * 10 + (i % 7))
  const y = filtfiltMovingAverage(x)
  const expected: [number, number][] = [
    [0, 0],
    [1, 0.09575072],
    [50, 2.659311895],
    [150, 3.065374612],
    [250, 2.881858763],
    [299, -4.984950307]
  ]
  check(
    'zero-phase 70-sample filter matches reference values',
    expected.every(([i, v]) => Math.abs(y[i] - v) < 1e-6),
    expected.map(([i]) => y[i])
  )
  check('short series is drawn unfiltered', filtfiltMovingAverage([1, 2, 3]).join() === '1,2,3')

  const parsed = parseStatusString('    5650     840      61      12       0       2', 100)
  check(
    'status string parses',
    parsed?.loadN === 56.5 && parsed.positionMm === 840 && parsed.code === 61 && parsed.upTimeSec === 12 && parsed.mode === 'AUTO',
    parsed
  )
  check('malformed status string is skipped', parseStatusString('12 34', 100) === null)

  const ref3600 = modelsRepo.list().find((m) => m.name === 'PANTO-3600')!
  const samples: Sample[] = []
  for (let h = 0; h <= 3600; h += 10) samples.push({ loadN: 56 + (h % 20 === 0 ? 1 : 0), positionMm: h, code: 61 })
  for (let h = 3600; h >= 0; h -= 10) samples.push({ loadN: 82 + (h % 20 === 0 ? 2 : 0), positionMm: h, code: 81 })
  const r = computeResults(samples, ref3600)
  check('window is the model points 2-3 (840-2910 mm)', r.windowFromMm === 840 && r.windowToMm === 2910, r)
  check('average up / down force', Math.abs(r.avgUpN - 56.5) < 0.02 && Math.abs(r.avgDownN - 83) < 0.03, r)
  check('mean = (up + down) / 2, hysteresis = down - up', Math.abs(r.meanN - (r.avgUpN + r.avgDownN) / 2) < 1e-9 && Math.abs(r.hysteresisN - (r.avgDownN - r.avgUpN)) < 1e-9)
  check('peak friction = max(down) - min(up)', r.peakFrictionN === 84 - 56, r.peakFrictionN)
  check('max height = highest raising position', r.maxHeightMm === 3600)
}

async function s7Tests(): Promise<void> {
  console.log('\nSiemens S7 (fake S7-1200 over ISO-on-TCP)')
  const fake = new FakeS7Plc()
  const port = await fake.listen()
  const ref3600 = modelsRepo.list().find((m) => m.name === 'PANTO-3600')!
  fake.plc.setModel(ref3600)
  const hw: HardwareConfig = {
    ...DEFAULT_HARDWARE_CONFIG,
    driver: 's7',
    s7: { ...DEFAULT_HARDWARE_CONFIG.s7, connection: { ...DEFAULT_HARDWARE_CONFIG.s7.connection, host: '127.0.0.1', port } }
  }

  const probe = await config.testHardwareConfig(hw)
  check('TEST CONNECTION reads the status string', probe.status === 'HOMING NOT DONE', probe)
  check('TEST CONNECTION does not write', fake.writes.length === 0, fake.writes.length)

  await config.setHardwareConfig(hw)
  check('connects', await waitFor(() => getHardware().getState().connected, 5000))
  check('speeds written as REALs at DB6.DBD6/10/14', await waitFor(() => fake.db.readFloatBE(6) === 50 && fake.db.readFloatBE(10) === 50 && fake.db.readFloatBE(14) === 50, 2000))

  await config.upload({ speeds: { up: 500, down: 500, jog: 200 }, distanceMm: 3600 })
  check('UPLOAD sends new speeds to the PLC', fake.db.readFloatBE(6) === 500 && fake.db.readFloatBE(14) === 200)

  tests.select(ref3600.id, 'P-001')
  await tests.start()
  await waitFor(() => code() === StatusCode.HOMING_NOT_DONE, 2000)
  check('START before homing: PLC answers HOMING NOT DONE', code() === StatusCode.HOMING_NOT_DONE, code())

  const homeStart = Date.now()
  await tests.home()
  check('HOMING pulses DB6.DBX1.0 for 2 s', Date.now() - homeStart >= 1900 && (fake.db[1] & 1) === 0)
  check('homed: READY', await waitFor(() => code() === StatusCode.READY, 5000), code())

  const codes = await runCycle('S7 cycle')
  check('START sets DB6.DBX0.3', fake.writes.some((w) => w.bit && w.address === 3 && w.data[0] === 1))
  check('START writes the travel distance to DB6.DBD2', fake.db.readFloatBE(2) === 3600)
  check(
    'status sequence 61 → 71 → 81 → 91 → 0',
    JSON.stringify(codes.filter((c) => [61, 71, 81, 91, 0].includes(c))).includes('61,71,81,91'),
    codes
  )
  const history = tests.getHistory()
  check('test n recorded', history.n.length > 100, history.n.length)
  check('recording stops at CYCLE COMPLETED', history.n[history.n.length - 1].code === StatusCode.CYCLE_COMPLETED)
  const r = computeResults(history.n, ref3600)
  check('results within the reference band', r.avgUpN > 52 && r.avgUpN < 63 && r.avgDownN > 77 && r.avgDownN < 88, r)

  // Report on test n
  config.setMachineSettings({ ...config.getMachineSettings(), company: { name: 'ACME RAIL TESTING', addressLine1: 'Line 1', addressLine2: '' } })
  const png = readFileSync(join(root, 'resources', 'icon.png')).toString('base64')
  const report = await generateReport(`data:image/png;base64,${png}`)
  check('report files written', [report.excelPath, report.pdfPath, report.jsonPath].every((f) => existsSync(f) && statSync(f).size > 1000), report)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(report.excelPath)
  const ws = wb.worksheets[0]
  const cells: unknown[] = []
  ws.eachRow((row) => row.eachCell((cell) => cells.push(cell.value)))
  const text = cells.map((c) => (c instanceof Date ? 'DATE' : String(c)))
  check('Excel: model, part no and name', text.includes('PANTO-3600') && text.includes('P-001') && text.includes('ADMIN'))
  check('Excel: company lines from settings', text.includes('ACME RAIL TESTING'))
  check('Excel: average up force', cells.some((c) => typeof c === 'number' && Math.abs(c - r.avgUpN) < 0.5))
  check('Excel: data sheet holds every sample', wb.getWorksheet('Data')!.rowCount === history.n.length + 1)
  check('report file name from model and part number', /PANTO-3600_P-001_\d{8}_\d{6}\.xlsx$/.test(report.excelPath), report.excelPath)
  check('Excel: graph image', ws.getImages().length === 1, ws.getImages().length)
  const json = JSON.parse(readFileSync(report.jsonPath, 'utf8'))
  check('JSON: results and samples', json.model === 'PANTO-3600' && json.samples.rows.length === history.n.length && typeof json.results.meanForceN === 'number')
  check('PDF: one A4 page', (readFileSync(report.pdfPath, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length === 1)

  // STOP / resume, and RESET rotates the history
  const firstRun = history.n.length
  await tests.reset()
  const rotated = tests.getHistory()
  check('RESET: n moves to n-1, n is empty', rotated.n.length === 0 && rotated.n1.length === firstRun, [rotated.n.length, rotated.n1.length])
  check('RESET sets DB6.DBX0.6', fake.writes.some((w) => w.bit && w.address === 6 && w.data[0] === 1))
  await waitFor(() => code() === StatusCode.READY, 3000)
  const watch = watchCodes()
  await tests.start()
  await waitFor(() => code() === StatusCode.PANTO_RAISING, 3000)
  await sleep(300)
  await tests.stop()
  check('STOP: HALT', await waitFor(() => code() === StatusCode.HALT, 3000), { now: code(), seen: watch.codes, pos: getHardware().getState().positionMm, fakeCode: fake.plc.code, writes: fake.writes.slice(-6).map((w) => [w.address, w.bit, [...w.data]]) })
  check('STOP sets DB6.DBX1.2', (fake.db[1] & 0b100) !== 0)
  const heightAtHalt = getHardware().getState().positionMm
  await sleep(300)
  check('halted: no motion', getHardware().getState().positionMm === heightAtHalt)
  await tests.start()
  check('START after STOP clears DB6.DBX1.2 and resumes', await waitFor(() => code() === StatusCode.PANTO_RAISING, 3000) && (fake.db[1] & 0b100) === 0)
  await waitFor(() => watch.codes.includes(StatusCode.CYCLE_COMPLETED), 30000)
  watch.stop()
  check('resumed cycle completes', watch.codes.includes(StatusCode.CYCLE_COMPLETED), watch.codes)
  await tests.reset()
  const h2 = tests.getHistory()
  check('second RESET: n-1 → n-2', h2.n2.length === firstRun && h2.n1.length > 0, [h2.n1.length, h2.n2.length])

  // History survives a restart of the service
  tests.initTestService()
  const reloaded = tests.getHistory()
  check('n-1 / n-2 reload from the database', reloaded.n1.length === h2.n1.length && reloaded.n2.length === h2.n2.length)

  // Pulled cable
  const reconnects = watchCodes()
  fake.dropClients()
  check('link loss: ETHERNET DISCONNECTED', await waitFor(() => !getHardware().getState().connected, 3000))
  let refused = ''
  try {
    await tests.start()
  } catch (error) {
    refused = (error as Error).message
  }
  check('START while disconnected is refused', refused.includes('ETHERNET DISCONNECTED'), refused)
  check('reconnects by itself', await waitFor(() => getHardware().getState().connected, 8000))
  reconnects.stop()
  check('status 100 was shown', reconnects.codes.includes(100), reconnects.codes)

  // PUT/GET not allowed in the PLC
  fake.denyAccess = true
  let denied = ''
  try {
    await config.testHardwareConfig(hw)
  } catch (error) {
    denied = (error as Error).message
  }
  check('PUT/GET refused: clear message', denied.includes('PUT/GET'), denied)
  fake.denyAccess = false

  // Wrong slot
  let wrongSlot = ''
  try {
    await config.testHardwareConfig({ ...hw, s7: { ...hw.s7, connection: { ...hw.s7.connection, slot: 2 } } })
  } catch (error) {
    wrongSlot = (error as Error).message
  }
  check('wrong rack/slot: refused', wrongSlot.length > 0, wrongSlot)

  await config.setHardwareConfig({ ...hw, driver: 'simulator' })
  await fake.close()
}

async function modbusTests(): Promise<void> {
  for (const transport of ['rtu-tcp', 'tcp'] as const) {
    console.log(`\nModbus ${transport === 'tcp' ? 'TCP' : 'RTU over TCP'} (fake PLC)`)
    const fake = new FakePlc()
    const port = 15020 + (transport === 'tcp' ? 1 : 0)
    if (transport === 'tcp') await fake.listenTcp(port)
    else await fake.listenRtuOverTcp(port)
    const ref3600 = modelsRepo.list().find((m) => m.name === 'PANTO-3600')!
    fake.plc.setModel(ref3600)
    const hw: HardwareConfig = {
      ...DEFAULT_HARDWARE_CONFIG,
      driver: 'modbus',
      modbus: {
        ...DEFAULT_HARDWARE_CONFIG.modbus,
        connection: { ...DEFAULT_HARDWARE_CONFIG.modbus.connection, transport, host: '127.0.0.1', port }
      }
    }
    await config.setHardwareConfig(hw)
    check('connects', await waitFor(() => getHardware().getState().connected, 5000))
    await tests.home()
    check('homed: READY', await waitFor(() => code() === StatusCode.READY, 5000), code())
    const codes = await runCycle('Modbus cycle')
    check('status sequence', JSON.stringify(codes).includes('61,71,81,91'), codes)
    await tests.reset()
    await config.setHardwareConfig({ ...hw, driver: 'simulator' })
    await fake.shutdown()
  }
}

async function simulatorTests(): Promise<void> {
  console.log('\nSimulator')
  await config.setHardwareConfig({ ...DEFAULT_HARDWARE_CONFIG, driver: 'simulator' })
  check('connects', await waitFor(() => getHardware().getState().connected, 3000))
  await tests.home()
  check('homing → READY', await waitFor(() => code() === StatusCode.READY, 5000))
  await tests.forceFault('EMERGENCY')
  check('E-stop → EMERGENCY PRESSED', await waitFor(() => code() === StatusCode.EMERGENCY_PRESSED, 2000))
  await tests.start()
  await sleep(200)
  check('START refused by the PLC during a fault', code() === StatusCode.EMERGENCY_PRESSED)
  await tests.reset()
  check('RESET clears the fault', await waitFor(() => code() === StatusCode.READY, 2000), code())
  await tests.forceFault('DISCONNECT')
  check('cable pull → disconnected', await waitFor(() => !getHardware().getState().connected, 2000))
  check('reconnects after the outage', await waitFor(() => getHardware().getState().connected, 12000))
}

async function authTests(): Promise<void> {
  console.log('\nUsers and settings')
  check('default login ADMIN / 1234', auth.login('ADMIN', '1234') !== null)
  check('operator login OPERATOR1 / 123', auth.login('OPERATOR1', '123') !== null)
  check('wrong password refused', auth.login('ADMIN', '123') === null)
  check('names are matched exactly', auth.login('admin', '1234') === null)
  const admin = auth.login('ADMIN', '1234')!
  auth.startSession(admin)
  check('Settings need the first user name + password', !auth.unlockAdmin('OPERATOR1', '123') && auth.unlockAdmin('ADMIN', '1234'))
  const users = config.saveUserNames(['ADMIN', 'RAVI', 'OPERATOR2', 'OPERATOR3'])
  check('employee names saved', users[1].displayName === 'RAVI' && auth.login('RAVI', '123') !== null)
  config.changePassword(users[1].id, 'newpass')
  check('CHANGE password', auth.login('RAVI', 'newpass') !== null && auth.login('RAVI', '123') === null)
  const stored = settingsRepo.getAll()
  check('passwords are not stored in clear text', !JSON.stringify(stored).includes('newpass'))

  const ref3600 = modelsRepo.list().find((m) => m.name === 'PANTO-3600')!
  const before = modelsRepo.list().length
  const saved = config.saveModel({ id: ref3600.id, name: 'PANTO-3500', points: ref3600.points })
  check('new model name adds a model', saved.models.length === before + 1 && !!modelsRepo.get(ref3600.id))
  check('saved model becomes current', tests.getSelection().modelName === 'PANTO-3500')
  const edited = config.saveModel({
    id: saved.current.id,
    name: 'PANTO-3500',
    points: saved.current.points.map((p) => (p.rowIndex === 4 || p.rowIndex === 5 ? { ...p, heightMm: 3500 } : p))
  })
  check('same name updates in place; Y4 is the travel distance', edited.models.length === before + 1 && edited.current.distanceMm === 3500)
  let empty = ''
  try {
    config.saveModel({ name: '', points: ref3600.points })
  } catch (error) {
    empty = (error as Error).message
  }
  check('empty model name refused', empty === 'Model Cannot Be Empty')
  tests.select(ref3600.id, '')
  check('empty Part-No becomes #####', tests.getSelection().partNo === '#####')
}

async function main(): Promise<void> {
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  app.setPath('userData', join(work, 'userData'))
  app.setPath('documents', join(work, 'documents'))
  // The hidden PDF window is the only window; closing it must not quit the test.
  app.on('window-all-closed', () => undefined)
  await app.whenReady()
  initDb(join(work, 'pltm.db'))
  settingsRepo.set('hardware_config', JSON.stringify({ ...DEFAULT_HARDWARE_CONFIG, driver: 'simulator' }))
  initHardware()
  // As src/main/index.ts does: every poll goes through the test service.
  getHardware().on('state', (state) => tests.onState(state))
  getHardware().startSupervision()
  tests.initTestService()
  try {
    await authTests()
    await analysisTests()
    await s7Tests()
    await modbusTests()
    await simulatorTests()
    console.log(`\nTest runs in the database: ${testRunsRepo.get(1) ? 'yes' : 'no'}`)
  } catch (error) {
    failures++
    console.error(error)
  } finally {
    getHardware().stopSupervision()
    await getHardware().disconnect()
    closeDb()
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
    app.exit(failures ? 1 : 0)
  }
}

void main()
