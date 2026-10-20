/**
 * End-to-end test of Modbus RTU over a serial port — the USB-to-RS485 adapter
 * path. socat creates a linked pair of virtual serial ports; the fake PLC owns
 * one end and the real driver (serialport + modbus-serial) opens the other, as
 * it would a COM port. Requires socat (brew install socat).
 * Run with: npm run test:serial
 */
import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SerialPort } from 'serialport'
import { HardwareStatus, type HardwareConfig } from '@shared/types'
import { closeDb, initDb } from '../src/main/db'
import { modelsRepo, settingsRepo, testRunsRepo } from '../src/main/db/repositories'
import { DEFAULT_CONNECTION, DEFAULT_REGISTER_MAP } from '../src/main/hardware/config'
import { getHardware, initHardware } from '../src/main/hardware/HardwareManager'
import { setHardwareConfig, testHardwareConfig } from '../src/main/services/configService'
import {
  CommandError,
  finishRun,
  homeMachine,
  jogMachine,
  recordCycle,
  recordTelemetry,
  resetMachine,
  startRun,
  stopRun
} from '../src/main/services/testRunService'
import { FakePlc } from './fakePlc'

const dir = join(tmpdir(), 'pltm-serial-test')
const PLC_TTY = join(dir, 'plc-tty')
const APP_TTY = join(dir, 'app-tty')

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

async function expectError(label: string, code: string, fn: () => Promise<unknown>, text?: string): Promise<void> {
  try {
    await fn()
    check(label, false, '(no error thrown)')
  } catch (error) {
    const actual = error instanceof CommandError ? error.code : String(error)
    const message = error instanceof Error ? error.message : ''
    check(label, actual === code && (!text || message.includes(text)), `(got ${actual}: ${message})`)
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

/** Starts socat with a linked pty pair; returns once both ends exist. */
async function startVirtualCable(): Promise<ChildProcess> {
  const socat = spawn('socat', [
    `pty,raw,echo=0,link=${PLC_TTY}`,
    `pty,raw,echo=0,link=${APP_TTY}`
  ])
  socat.on('error', (error) => {
    console.error('socat failed to start — install it with: brew install socat', error.message)
    app.exit(1)
  })
  await waitFor(() => existsSync(PLC_TTY) && existsSync(APP_TTY), 5000)
  return socat
}

async function attachPlc(plc: FakePlc): Promise<SerialPort> {
  const port = new SerialPort({ path: PLC_TTY, baudRate: 9600 })
  await new Promise<void>((resolve, reject) => port.once('open', resolve).once('error', reject))
  plc.serveRtu(port)
  return port
}

async function main(): Promise<void> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'profile'), { recursive: true })
  app.setPath('userData', join(dir, 'profile'))
  initDb()
  settingsRepo.setSpeeds({ up: 2000, down: 2000, jog: 1000 })

  let cable = await startVirtualCable()
  const plc = new FakePlc()
  let plcPort = await attachPlc(plc)

  const hardware = initHardware()
  hardware.on('status', (status) => {
    if ([HardwareStatus.READY, HardwareStatus.OVERLOAD, HardwareStatus.DISCONNECTED].includes(status)) {
      finishRun(status)
    }
  })
  hardware.on('telemetry', (frame) => recordTelemetry(frame))
  hardware.on('cycle-complete', (event) => recordCycle(event.phase, event.elapsedSec))

  const config: HardwareConfig = {
    driver: 'modbus',
    connection: {
      ...DEFAULT_CONNECTION,
      transport: 'rtu-serial',
      serialPath: APP_TTY,
      baudRate: 9600,
      parity: 'none',
      dataBits: 8,
      stopBits: 1,
      unitId: 1,
      timeoutMs: 500,
      pollIntervalMs: 100
    },
    registerMap: DEFAULT_REGISTER_MAP
  }

  console.log('\nSerial port discovery')
  const ports = await SerialPort.list()
  check('serial port enumeration works', Array.isArray(ports), `(${ports.length} ports)`)

  console.log('\nConnection test over the serial line')
  const writesBefore = plc.writes
  const probe = await testHardwareConfig(config)
  check('probe reads status over RTU serial', probe.status === HardwareStatus.HOMING_NOT_DONE, `(${probe.status})`)
  check('probe is read-only', plc.writes === writesBefore)
  check('probe releases the COM port (reopen works)', (await testHardwareConfig(config)).status === HardwareStatus.HOMING_NOT_DONE)

  console.log('\nConfiguration errors give clear messages')
  await expectError('missing COM port reported', 'ERR_CONNECTION_FAILED', () =>
    testHardwareConfig({ ...config, connection: { ...config.connection, serialPath: join(dir, 'COM99') } })
  )
  await expectError('wrong slave ID reported as no response', 'ERR_CONNECTION_FAILED', () =>
    testHardwareConfig({ ...config, connection: { ...config.connection, unitId: 7 } })
  )
  await expectError('register outside the PLC range reported as a Modbus exception', 'ERR_CONNECTION_FAILED', () =>
    testHardwareConfig({ ...config, registerMap: { ...DEFAULT_REGISTER_MAP, status: { area: 'input', address: 900 } } }),
    'xception'
  )

  console.log('\nOperation over RS-485 (virtual)')
  await setHardwareConfig(config)
  check('driver connects on the COM port', await waitFor(() => hardware.getSnapshot().connected, 5000))
  hardware.startSupervision()
  check('speeds written over serial', await waitFor(() => plc.holding[0] === 20000, 2000), `(${plc.holding[0]})`)

  const model = modelsRepo.list()[0]
  const request = { modelId: model.id, employeeUserId: 1, partNo: 'RS485-001' }
  await homeMachine()
  check('HOMING over serial', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 3000))
  await startRun(request)
  check('travel distance written over serial', plc.travelMm === model.distanceMm)
  check('test raises', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING, 2000))
  await waitFor(() => hardware.getSnapshot().heightMm > 500, 5000)
  await stopRun()
  check('STOP over serial', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.HALT, 2000))
  await startRun(request)
  check('RESUME over serial', await waitFor(() => hardware.getSnapshot().status !== HardwareStatus.HALT, 2000))
  check('full cycle completes', await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 20000))
  const run = testRunsRepo.lastCompleted()
  check('run recorded with telemetry', run?.resultStatus === 'COMPLETED' && testRunsRepo.points(run.id).length > 10)

  plc.manualMode = true
  await waitFor(() => hardware.getSnapshot().mode === 'MANUAL', 2000)
  await resetMachine()
  await jogMachine('UP', true)
  check('jog command over serial', await waitFor(() => plc.coils[4] === 1, 1000))
  check('jog watchdog releases over serial', await waitFor(() => plc.coils[4] === 0, 2000))
  plc.manualMode = false
  await waitFor(() => hardware.getSnapshot().mode === 'AUTO', 2000)

  console.log('\nUSB adapter unplugged and replugged')
  await homeMachine()
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.READY, 2000)
  settingsRepo.setSpeeds({ up: 200, down: 200, jog: 1000 })
  await hardware.setSpeeds({ up: 200, down: 200, jog: 1000 })
  await startRun(request)
  await waitFor(() => hardware.getSnapshot().status === HardwareStatus.PANTO_RAISING, 2000)
  // A real unplug: the device vanishes; nothing is closed gracefully first.
  let maxStallMs = 0
  let lastTick = Date.now()
  const stallProbe = setInterval(() => {
    maxStallMs = Math.max(maxStallMs, Date.now() - lastTick - 20)
    lastTick = Date.now()
  }, 20)
  cable.kill('SIGKILL')
  const unpluggedAt = Date.now()
  console.log(`        (unplugged at ${new Date(unpluggedAt).toISOString()})`)
  const detected = await waitFor(() => !hardware.getSnapshot().connected, 8000)
  check('unplug detected within 8 s', detected, `(${Date.now() - unpluggedAt} ms)`)
  clearInterval(stallProbe)
  check('app stays responsive during unplug', maxStallMs < 500, `(event loop stalled ${maxStallMs} ms)`)
  plcPort.destroy()
  check('run in progress closed as DISCONNECTED', testRunsRepo.lastCompleted()?.resultStatus === HardwareStatus.DISCONNECTED)
  await sleep(1000)
  cable = await startVirtualCable()
  plcPort = await attachPlc(plc)
  check('reconnects after replug', await waitFor(() => hardware.getSnapshot().connected, 10000))
  check('live readings resume', await waitFor(() => hardware.getSnapshot().status !== HardwareStatus.DISCONNECTED, 2000))

  hardware.stopSupervision()
  await getHardware().disconnect()
  plcPort.close()
  cable.kill()
  await plc.shutdown()
  closeDb()
  console.log(failures === 0 ? '\nAll serial checks passed.\n' : `\n${failures} serial check(s) failed.\n`)
  app.exit(failures === 0 ? 0 : 1)
}

app.whenReady().then(() =>
  main().catch((error) => {
    console.error(error)
    app.exit(1)
  })
)
