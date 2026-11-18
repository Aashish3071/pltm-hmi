/**
 * End-to-end test of Modbus RTU over a serial port — the USB-to-RS485 adapter
 * path. socat creates a linked pair of virtual serial ports; the fake PLC owns
 * one end and the real driver (serialport + modbus-serial) opens the other, as
 * it would a COM port. Requires socat (brew install socat).
 * Run with: npm run test:serial
 */
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SerialPort } from 'serialport'
import { StatusCode, type HardwareConfig } from '@shared/types'
import { closeDb, initDb } from '../src/main/db'
import { modelsRepo, settingsRepo } from '../src/main/db/repositories'
import { DEFAULT_HARDWARE_CONFIG } from '../src/main/hardware/config'
import { getHardware, initHardware } from '../src/main/hardware/HardwareManager'
import { setHardwareConfig, testHardwareConfig } from '../src/main/services/configService'
import { CommandError } from '../src/main/errors'
import * as tests from '../src/main/services/testService'
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

function code(): number {
  const st = getHardware().getState()
  return st.connected ? st.code : 100
}

async function main(): Promise<void> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'profile'), { recursive: true })
  app.setPath('userData', join(dir, 'profile'))
  initDb(join(dir, 'pltm.db'))
  settingsRepo.set('hardware_config', JSON.stringify({ ...DEFAULT_HARDWARE_CONFIG, driver: 'simulator' }))
  settingsRepo.setSpeeds({ up: 500, down: 500, jog: 200 })

  let cable = await startVirtualCable()
  const plc = new FakePlc()
  const ref3600 = modelsRepo.list().find((m) => m.name === 'PANTO-3600')!
  plc.plc.setModel(ref3600)
  let plcPort = await attachPlc(plc)

  const hardware = initHardware()
  hardware.on('state', (state) => tests.onState(state))
  tests.initTestService()

  const config: HardwareConfig = {
    ...DEFAULT_HARDWARE_CONFIG,
    driver: 'modbus',
    modbus: {
      ...DEFAULT_HARDWARE_CONFIG.modbus,
      connection: {
        ...DEFAULT_HARDWARE_CONFIG.modbus.connection,
        transport: 'rtu-serial',
        serialPath: APP_TTY,
        baudRate: 9600,
        timeoutMs: 500,
        pollIntervalMs: 50
      }
    }
  }

  console.log('\nSerial port discovery')
  const ports = await SerialPort.list()
  check('serial port enumeration works', Array.isArray(ports), `(${ports.length} ports)`)

  console.log('\nConnection test over the serial line')
  const writesBefore = plc.writes
  const probe = await testHardwareConfig(config)
  check('probe reads status over RTU serial', probe.status === 'HOMING NOT DONE', `(${probe.status})`)
  check('probe is read-only', plc.writes === writesBefore)
  check('probe releases the COM port (reopen works)', (await testHardwareConfig(config)).status === 'HOMING NOT DONE')

  console.log('\nConfiguration errors give clear messages')
  const c = config.modbus.connection
  await expectError('missing COM port reported', 'ERR_CONNECTION_FAILED', () =>
    testHardwareConfig({ ...config, modbus: { ...config.modbus, connection: { ...c, serialPath: join(dir, 'COM99') } } })
  )
  await expectError('wrong slave ID reported as no response', 'ERR_CONNECTION_FAILED', () =>
    testHardwareConfig({ ...config, modbus: { ...config.modbus, connection: { ...c, unitId: 7 } } })
  )
  await expectError('register outside the PLC range reported as a Modbus exception', 'ERR_CONNECTION_FAILED', () =>
    testHardwareConfig({ ...config, modbus: { ...config.modbus, map: { ...config.modbus.map, status: { area: 'holding', address: 900 } } } }),
    'xception'
  )

  console.log('\nOperation over RS-485 (virtual)')
  await setHardwareConfig(config)
  check('driver connects on the COM port', await waitFor(() => hardware.getState().connected, 5000))
  hardware.startSupervision()
  tests.select(ref3600.id, 'RS485-001')
  await tests.home()
  check('HOMING over serial', await waitFor(() => code() === StatusCode.READY, 5000), `(${code()})`)
  await tests.start()
  check('test raises', await waitFor(() => code() === StatusCode.PANTO_RAISING, 2000))
  await waitFor(() => hardware.getState().positionMm > 500, 5000)
  await tests.stop()
  check('STOP over serial', await waitFor(() => code() === StatusCode.HALT, 2000))
  await tests.start()
  check('RESUME over serial', await waitFor(() => code() === StatusCode.PANTO_RAISING, 2000))
  check('full cycle completes', await waitFor(() => code() === StatusCode.CYCLE_COMPLETED, 30000))
  check('test recorded', tests.getHistory().n.length > 50)

  console.log('\nUSB adapter unplugged and replugged')
  await tests.reset()
  await waitFor(() => code() === StatusCode.READY, 3000)
  await tests.start()
  await waitFor(() => code() === StatusCode.PANTO_RAISING, 2000)
  let maxStallMs = 0
  let lastTick = Date.now()
  const stallProbe = setInterval(() => {
    maxStallMs = Math.max(maxStallMs, Date.now() - lastTick - 20)
    lastTick = Date.now()
  }, 20)
  cable.kill('SIGKILL')
  const unpluggedAt = Date.now()
  const detected = await waitFor(() => !hardware.getState().connected, 8000)
  check('unplug detected within 8 s', detected, `(${Date.now() - unpluggedAt} ms)`)
  clearInterval(stallProbe)
  check('app stays responsive during unplug', maxStallMs < 500, `(event loop stalled ${maxStallMs} ms)`)
  check('status shows ETHERNET DISCONNECTED (code 100)', code() === 100)
  plcPort.destroy()
  await sleep(1000)
  cable = await startVirtualCable()
  plcPort = await attachPlc(plc)
  check('reconnects after replug', await waitFor(() => hardware.getState().connected, 10000))

  hardware.stopSupervision()
  await getHardware().disconnect()
  plcPort.close()
  cable.kill()
  await plc.shutdown()
  closeDb()
  console.log(failures === 0 ? '\nAll serial checks passed.\n' : `\n${failures} serial check(s) failed.\n`)
  app.exit(failures === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  // Virtual COM-port pairs come from socat, which exists on macOS/Linux only.
  if (spawnSync('socat', ['-V']).error) {
    console.log('\nSKIPPED serial test: socat is not installed (macOS: brew install socat).\n')
    app.exit(0)
    return
  }
  return main().catch((error) => {
    console.error(error)
    app.exit(1)
  })
})
