/**
 * Tests the PantoCheck controller firmware (firmware/pltm-controller) without
 * the Arduino: firmware/host/sim.cpp compiles the firmware's own Controller and
 * ModbusSlave code for this PC, simulates the pantograph, and serves Modbus RTU
 * on a pseudo-terminal. The app's controller driver connects to it as to a COM
 * port, and the suite runs the test cycle and every safety function.
 *
 * Needs a C++ compiler (g++ or clang++); macOS / Linux only.
 * Run with: npm run test:firmware
 */
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { StatusCode, type HardwareConfig } from '@shared/types'
import { closeDb, initDb } from '../src/main/db'
import { modelsRepo, settingsRepo } from '../src/main/db/repositories'
import { DEFAULT_HARDWARE_CONFIG } from '../src/main/hardware/config'
import { getHardware, initHardware } from '../src/main/hardware/HardwareManager'
import { setHardwareConfig, testHardwareConfig } from '../src/main/services/configService'
import * as tests from '../src/main/services/testService'

const root = join(__dirname, '..', '..')
const dir = join(tmpdir(), 'pltm-firmware-test')
const simBinary = join(root, 'scripts', 'out', 'pltm-sim')

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  PASS  ${label}`)
  else {
    failures++
    console.log(`  FAIL  ${label} ${detail}`)
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

interface SimState {
  status: number
  position: number
  physical: number
  velocity: number
  homed: boolean
  manual: boolean
  drive: boolean
  safetyStop: string
  requests: number
  crcErrors: number
}

/** The simulator process: send it commands, ask for its state. */
class Sim {
  private pending: ((state: SimState) => void)[] = []
  private buffer = ''
  path = ''

  constructor(private readonly child: ChildProcess) {
    child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      let newline: number
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.startsWith('PTY ')) this.path = line.slice(4).trim()
        else if (line.startsWith('{')) this.pending.shift()?.(JSON.parse(line))
      }
    })
  }

  send(command: string): void {
    this.child.stdin!.write(`${command}\n`)
  }

  state(): Promise<SimState> {
    return new Promise((resolve) => {
      this.pending.push(resolve)
      this.send('state')
    })
  }

  async waitState(predicate: (s: SimState) => boolean, timeoutMs = 15000): Promise<SimState | null> {
    const started = Date.now()
    for (;;) {
      const s = await this.state()
      if (predicate(s)) return s
      if (Date.now() - started > timeoutMs) return null
      await sleep(50)
    }
  }

  /** Stops the simulator and waits for it to exit (closing its virtual port). */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) return resolve()
      this.child.once('exit', () => resolve())
      this.child.stdin!.end()  // the simulator exits when stdin closes
    })
  }
}

function buildSim(): boolean {
  const compiler = ['g++', 'clang++'].find((c) => !spawnSync(c, ['--version']).error)
  if (!compiler) return false
  mkdirSync(join(root, 'scripts', 'out'), { recursive: true })
  const fw = join(root, 'firmware')
  const result = spawnSync(
    compiler,
    [
      '-std=c++17', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-result',
      // Shorter pendant hold so the mode change test does not wait 5 s.
      '-DPENDANT_MODE_HOLD_MS=600',
      `-I${join(fw, 'pltm-controller')}`,
      join(fw, 'host', 'sim.cpp'),
      join(fw, 'pltm-controller', 'Controller.cpp'),
      join(fw, 'pltm-controller', 'ModbusSlave.cpp'),
      '-o', simBinary
    ],
    { stdio: 'inherit' }
  )
  return result.status === 0
}

async function main(): Promise<void> {
  console.log('\nBuild')
  check('firmware compiles for the host with no warnings', buildSim())
  if (failures) return finish()

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'profile'), { recursive: true })
  app.setPath('userData', join(dir, 'profile'))
  initDb(join(dir, 'pltm.db'))
  settingsRepo.set('hardware_config', JSON.stringify({ ...DEFAULT_HARDWARE_CONFIG, driver: 'simulator' }))

  const sim = new Sim(spawn(simBinary, ['--pos', '150'], { stdio: ['pipe', 'pipe', 'inherit'] }))
  await waitFor(() => sim.path !== '', 3000)
  check('simulator serves a virtual COM port', sim.path !== '', `(${sim.path})`)

  const hardware = initHardware()
  tests.initTestService()
  const codeLog: number[] = []
  hardware.on('state', (state) => {
    tests.onState(state)
    const c = state.connected ? state.code : 100
    if (codeLog[codeLog.length - 1] !== c) codeLog.push(c)
  })
  const st = (): ReturnType<typeof hardware.getState> => hardware.getState()
  const code = (): number => (st().connected ? st().code : 100)

  const config: HardwareConfig = {
    ...DEFAULT_HARDWARE_CONFIG,
    driver: 'controller',
    controller: {
      connection: { ...DEFAULT_HARDWARE_CONFIG.controller.connection, serialPath: sim.path, timeoutMs: 500, pollIntervalMs: 50 }
    }
  }
  /** Speeds straight to the controller (the UI limits them to 500 mm/s). */
  const setSpeeds = async (up: number, down: number, jog: number): Promise<void> => {
    settingsRepo.setSpeeds({ up, down, jog })
    await hardware.writeSpeeds({ up, down, jog })
  }
  const setHeightCapacity = async (mm: number): Promise<void> => {
    settingsRepo.set('height_capacity_mm', String(mm))
    await hardware.refreshLimits()
  }
  /** HOMING, then waits for the controller and the app to be READY. */
  const rehome = async (): Promise<void> => {
    await waitFor(() => code() === StatusCode.READY || code() === StatusCode.HOMING_NOT_DONE, 2000)
    const beforeHome = await sim.state()
    await tests.home()
    await sleep(300)
    await sim.waitState((s) => !s.homed, 1000)
    // Homing runs at 30 mm/s (HOMING_SPEED_MM_S): allow for the distance to go.
    const homingMs = (Math.abs(beforeHome.position) / 30) * 1000 + 10000
    const done =
      !!(await sim.waitState((s) => s.homed && s.status === 1, homingMs)) &&
      (await waitFor(() => code() === StatusCode.READY, 2000))
    check('re-homed', done, `(app ${code()}, now ${JSON.stringify(await sim.state())})`)
  }
  const model = modelsRepo.list().find((m) => m.name === 'PANTO-1800') ?? modelsRepo.list()[0]
  tests.select(model.id, 'FW-001')

  console.log('\nConnection')
  const probe = await testHardwareConfig(config)
  check('read-only probe reads HOMING NOT DONE', probe.status === 'HOMING NOT DONE', `(${probe.status})`)
  await setHardwareConfig(config)
  check('app connects to the controller', await waitFor(() => st().connected, 5000))
  hardware.startSupervision()
  check('power-up does not move anything', (await sim.state()).velocity === 0)

  console.log('\nHoming')
  await tests.start()
  await sleep(500)
  check('START before homing: the controller does not move', (await sim.state()).velocity === 0 && code() === StatusCode.HOMING_NOT_DONE, `(${code()})`)
  await tests.reset()
  await tests.home()
  const homed = await sim.waitState((s) => s.homed && s.status === 1, 20000)
  check('homing drives down to the switch and reaches READY', !!homed, JSON.stringify(await sim.state()))
  check('0 mm is where the home switch opens', !!homed && homed.physical >= 0 && homed.physical < 1 && Math.abs(homed.position) < 0.5, JSON.stringify(homed))
  check('app shows READY', await waitFor(() => code() === StatusCode.READY, 2000))

  console.log('\nTest cycle')
  await setSpeeds(1000, 1000, 50)
  codeLog.length = 0
  await tests.start()
  check('PANTO RAISING', await waitFor(() => code() === StatusCode.PANTO_RAISING, 2000))
  let top = 0
  const topWatch = setInterval(() => (top = Math.max(top, st().positionMm)), 50)
  check('CYCLE COMPLETED, then READY', await waitFor(() => codeLog.includes(StatusCode.CYCLE_COMPLETED) && code() === StatusCode.READY, 25000), `(${codeLog.join(' > ')})`)
  clearInterval(topWatch)
  check(
    'status sequence 61 > 71 > 81 > 91 > 0',
    codeLog.join('>').includes([61, 71, 81, 91, 0].join('>')),
    `(${codeLog.join(' > ')})`
  )
  check('rises to the model travel distance', Math.abs(top - model.distanceMm) < 5, `(${top} of ${model.distanceMm} mm)`)
  const atRest = await sim.state()
  check('stops back at 0 mm', Math.abs(atRest.position) < 0.5 && atRest.velocity === 0, JSON.stringify(atRest))
  const n = tests.getHistory().n
  check('test recorded and closed at CYCLE COMPLETED', n.length > 10 && n[n.length - 1].code === StatusCode.CYCLE_COMPLETED, `(${n.length} samples)`)
  check('raising and lowering times counted', st().upTimeSec > 0 && st().downTimeSec > 0, JSON.stringify(st()))

  console.log('\nStop and resume')
  await tests.reset()
  check('RESET moves the test to n-1', tests.getHistory().n.length === 0 && tests.getHistory().n1.length === n.length)
  await setSpeeds(800, 1000, 50)
  await tests.start()
  await waitFor(() => st().positionMm > 600, 5000)
  await tests.stop()
  check('STOP halts', await waitFor(() => code() === StatusCode.HALT, 2000))
  const halted = await sim.waitState((s) => s.velocity === 0, 1000)
  await sleep(400)
  check('position holds while halted', !!halted && Math.abs((await sim.state()).position - halted.position) < 0.01)
  await tests.start()
  check('RESUME continues raising', await waitFor(() => code() === StatusCode.PANTO_RAISING, 2000))
  check('resumed run completes', await waitFor(() => code() === StatusCode.READY, 25000))

  console.log('\nOverload trip (controller side)')
  await tests.reset()
  await tests.start()
  await waitFor(() => st().positionMm > 300, 5000)
  sim.send('load 600')
  const tripped = await sim.waitState((s) => s.safetyStop === 'overload', 2000)
  check('controller trips by itself above the overload limit', !!tripped)
  check('motion stops at once', !!(await sim.waitState((s) => s.velocity === 0, 1000)))
  check('app shows OVERLOAD', await waitFor(() => code() === StatusCode.OVERLOAD, 2000), `(${code()})`)
  sim.send('load auto')
  await sleep(300)
  check('the trip stays latched after the load drops', code() === StatusCode.OVERLOAD)
  await tests.reset()
  check('RESET clears it', await waitFor(() => code() === StatusCode.READY, 2000), `(${code()})`)

  console.log('\nE-stop')
  await rehome()
  await tests.start()
  await waitFor(() => st().positionMm > 300, 5000)
  sim.send('estop 1')
  check('EMERGENCY PRESSED at once', await waitFor(() => code() === StatusCode.EMERGENCY_PRESSED, 1000))
  const stopped = await sim.state()
  check('drive disabled and not moving', !stopped.drive && stopped.velocity === 0, JSON.stringify(stopped))
  await tests.reset()
  await sleep(300)
  check('RESET cannot clear a pressed E-stop', code() === StatusCode.EMERGENCY_PRESSED)
  sim.send('estop 0')
  await sleep(400)
  const released = await sim.state()
  check('releasing the E-stop restarts nothing', code() === StatusCode.EMERGENCY_PRESSED && released.velocity === 0 && Math.abs(released.position - stopped.position) < 0.01)
  await tests.reset()
  check('release + RESET recovers', await waitFor(() => code() === StatusCode.READY, 2000), `(${code()})`)

  console.log('\nCommunication watchdog')
  await rehome()
  await setSpeeds(300, 1000, 50)
  await tests.start()
  await waitFor(() => st().positionMm > 200, 5000)
  hardware.stopSupervision()
  await hardware.disconnect()
  const silentAt = Date.now()
  const halt = await sim.waitState((s) => s.safetyStop === 'watchdog' && s.status === 5 && s.velocity === 0, 4000)
  check('controller halts within ~2 s when the app goes silent', !!halt && Date.now() - silentAt < 3500, `(${Date.now() - silentAt} ms)`)
  await hardware.tryConnect()
  hardware.startSupervision()
  check('app reconnects and sees HALT', await waitFor(() => st().connected && code() === StatusCode.HALT, 5000), `(${code()})`)
  await tests.reset()

  console.log('\nSoft travel limit (height capacity) and pendant jog in MANUAL')
  await rehome()
  await setHeightCapacity(300)
  sim.send('pendant 1 1')
  await sleep(800)
  sim.send('pendant 0 0')
  check('holding both pendant buttons switches to MANUAL', await waitFor(() => st().mode === 'MANUAL', 2000))
  await setSpeeds(300, 1000, 200)
  sim.send('pendant 1 0')
  const overTravel = await waitFor(() => code() === StatusCode.OVER_TRAVEL, 6000)
  sim.send('pendant 0 0')
  const atLimit = (await sim.waitState((s) => s.velocity === 0, 2000)) ?? (await sim.state())
  check('jogging into the limit shows OVER TRAVEL', overTravel && atLimit.safetyStop === 'travel', `(${code()}, ${JSON.stringify(atLimit)})`)
  check('stops at the limit, not past it (200 mm/s jog)', atLimit.position >= 295 && atLimit.position <= 300.05, `(${atLimit.position} mm)`)
  await setHeightCapacity(4000)
  await tests.reset()
  check('RESET clears OVER TRAVEL', await waitFor(() => code() !== StatusCode.OVER_TRAVEL, 2000))
  sim.send('pendant 0 1')
  const jogged = await sim.waitState((s) => s.position < atLimit.position - 20, 3000)
  sim.send('pendant 0 0')
  check('pendant DOWN jogs while held', !!jogged)
  check('pendant release stops', !!(await sim.waitState((s) => s.velocity === 0, 1000)))
  sim.send('pendant 1 1')
  await sleep(800)
  sim.send('pendant 0 0')
  check('holding both again returns to AUTO', await waitFor(() => st().mode === 'AUTO', 2000))

  console.log('\nOver-travel switches and drive alarm')
  sim.send('upper 1')
  check('upper limit switch shows OVER TRAVEL even at rest', await waitFor(() => code() === StatusCode.OVER_TRAVEL, 2000))
  await tests.start()
  await sleep(400)
  check('START does nothing while a limit is tripped', (await sim.state()).velocity === 0 && code() === StatusCode.OVER_TRAVEL)
  sim.send('upper 0')
  await tests.reset()
  check('switch released + RESET clears it', await waitFor(() => code() !== StatusCode.OVER_TRAVEL, 2000))
  sim.send('alarm 1')
  check('drive alarm shows SERVO ERROR', await waitFor(() => code() === StatusCode.SERVO_ERROR, 2000), `(${code()})`)
  check('drive disabled on alarm', !(await sim.state()).drive)
  sim.send('alarm 0')
  await tests.reset()
  check('alarm cleared + RESET recovers', await waitFor(() => code() !== StatusCode.SERVO_ERROR, 2000))

  console.log('\nLine noise')
  const before = await sim.state()
  sim.send('noise 8')
  await sleep(1000)
  const after = await sim.state()
  check('garbage on the line does not break the link', st().connected && after.requests > before.requests + 3, `(${before.requests} -> ${after.requests} requests, ${after.crcErrors} CRC errors)`)

  hardware.stopSupervision()
  await getHardware().disconnect()
  await sim.stop()
  // Let serialport finish closing the port before Electron exits.
  await sleep(500)
  closeDb()
  finish()
}

function finish(): void {
  console.log(failures === 0 ? '\nAll firmware checks passed.\n' : `\n${failures} firmware check(s) failed.\n`)
  app.exit(failures === 0 ? 0 : 1)
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    console.log('\nSKIPPED firmware test: the host simulator needs macOS or Linux.\n')
    app.exit(0)
    return
  }
  return main().catch((error) => {
    console.error(error)
    app.exit(1)
  })
})
