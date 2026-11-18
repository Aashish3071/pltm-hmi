/**
 * Tests the Arduino controller firmware (firmware/pltm-controller) without the
 * Arduino: firmware/host/sim.cpp compiles the firmware's own Controller and
 * ModbusSlave code for this PC, simulates the pantograph, and serves Modbus
 * RTU on a pseudo-terminal. The app's real Modbus driver connects to it as to
 * a COM port with the app's default register map, and the suite runs the test
 * cycle and every safety function of docs/plc-safety-requirements.md.
 *
 * Needs a C++ compiler (g++ or clang++); macOS / Linux only.
 * Run with: npm run test:firmware
 */
import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

async function expectError(label: string, code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    check(label, false, '(no error thrown)')
  } catch (error) {
    const actual = error instanceof CommandError ? error.code : String(error)
    check(label, actual === code, `(got ${actual}: ${error instanceof Error ? error.message : ''})`)
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
  initDb()

  const sim = new Sim(spawn(simBinary, ['--pos', '150'], { stdio: ['pipe', 'pipe', 'inherit'] }))
  await waitFor(() => sim.path !== '', 3000)
  check('simulator serves a virtual COM port', sim.path !== '', `(${sim.path})`)

  const hardware = initHardware()
  const statusLog: HardwareStatus[] = []
  const cycles: string[] = []
  hardware.on('status', (status) => {
    statusLog.push(status)
    if ([HardwareStatus.READY, HardwareStatus.OVERLOAD, HardwareStatus.DISCONNECTED].includes(status)) finishRun(status)
  })
  hardware.on('telemetry', (frame) => recordTelemetry(frame))
  hardware.on('cycle-complete', (event) => {
    cycles.push(event.phase)
    recordCycle(event.phase, event.elapsedSec)
  })

  const config: HardwareConfig = {
    driver: 'modbus',
    connection: { ...DEFAULT_CONNECTION, transport: 'rtu-serial', serialPath: sim.path, timeoutMs: 500, pollIntervalMs: 100 },
    registerMap: DEFAULT_REGISTER_MAP
  }
  const setSpeeds = async (up: number, down: number, jog: number): Promise<void> => {
    settingsRepo.setSpeeds({ up, down, jog })
    await hardware.setSpeeds({ up, down, jog })
  }
  const snap = (): ReturnType<typeof hardware.getSnapshot> => hardware.getSnapshot()
  /** HOMING, then waits for it to start and to finish (the app too). */
  const rehome = async (): Promise<void> => {
    await waitFor(() => snap().status === HardwareStatus.READY || snap().status === HardwareStatus.HOMING_NOT_DONE, 2000)
    const beforeHome = await sim.state()
    await homeMachine()
    await sleep(300)
    const afterHome = await sim.state()
    await sim.waitState((s) => !s.homed, 1000)
    // Homing runs at 30 mm/s (HOMING_SPEED_MM_S): allow for the distance to go.
    const homingMs = (Math.abs(beforeHome.position) / 30) * 1000 + 10000
    const done =
      !!(await sim.waitState((s) => s.homed && s.status === 1, homingMs)) &&
      (await waitFor(() => snap().status === HardwareStatus.READY && snap().homed, 2000))
    check('re-homed', done, `(app ${snap().status}, before ${JSON.stringify(beforeHome)}, after HOME ${JSON.stringify(afterHome)}, now ${JSON.stringify(await sim.state())})`)
  }
  const model = modelsRepo.list().find((m) => m.name === 'RE260') ?? modelsRepo.list()[0]
  const request = { modelId: model.id, employeeUserId: 1, partNo: 'FW-001' }

  console.log('\nConnection with the default register map')
  const probe = await testHardwareConfig(config)
  check('read-only probe reads HOMING NOT DONE', probe.status === HardwareStatus.HOMING_NOT_DONE, `(${probe.status})`)
  const badMap = { ...config, registerMap: { ...DEFAULT_REGISTER_MAP, status: { area: 'input' as const, address: 200, dataType: 'uint16' as const } } }
  let badError = ''
  try { await testHardwareConfig(badMap) } catch (error) { badError = (error as Error).message }
  check('an address the firmware does not have is reported as a Modbus exception', /exception|illegal|address/i.test(badError), `(${badError})`)
  await setHardwareConfig(config)
  check('app connects to the firmware', await waitFor(() => snap().connected, 5000))
  hardware.startSupervision()
  check('safety signals all clear', await waitFor(() => !snap().safety.estop && !snap().safety.overloadTrip && !snap().safety.upperLimit && !snap().safety.lowerLimit, 2000), JSON.stringify(snap().safety))
  check('the firmware sees the app heartbeat', await waitFor(() => snap().safety.heartbeat, 3000))
  check('power-up does not move anything', (await sim.state()).velocity === 0)

  console.log('\nHoming')
  await expectError('START refused before homing', 'ERR_NOT_HOMED', () => startRun(request))
  await homeMachine()
  const homed = await sim.waitState((s) => s.homed && s.status === 1, 20000)
  check('homing drives down to the switch and reaches READY', !!homed, JSON.stringify(await sim.state()))
  check('0 mm is where the home switch opens', !!homed && homed.physical >= 0 && homed.physical < 1 && Math.abs(homed.position) < 0.5, JSON.stringify(homed))
  check('app shows READY and homed', await waitFor(() => snap().status === HardwareStatus.READY && snap().homed, 2000))

  console.log('\nTest cycle')
  await setSpeeds(1000, 1000, 50)
  statusLog.length = 0
  cycles.length = 0
  await startRun(request)
  check('RAISING', await waitFor(() => snap().status === HardwareStatus.PANTO_RAISING, 2000))
  let top = 0
  const topWatch = setInterval(() => (top = Math.max(top, snap().heightMm)), 50)
  check('returns to READY', await waitFor(() => statusLog.includes(HardwareStatus.PANTO_RETRIEVING) && snap().status === HardwareStatus.READY, 20000), `(${statusLog.join(' > ')})`)
  clearInterval(topWatch)
  check('statuses in order: RAISING > RAISING COMPLETED > RETRIEVING > READY', statusLog.join('>').includes([HardwareStatus.PANTO_RAISING, HardwareStatus.PANTO_RAISING_COMPLETED, HardwareStatus.PANTO_RETRIEVING, HardwareStatus.READY].join('>')), `(${statusLog.join(' > ')})`)
  check('rises to the model travel distance', Math.abs(top - model.distanceMm) < 5, `(${top} of ${model.distanceMm} mm)`)
  const atRest = await sim.state()
  check('stops back at 0 mm', Math.abs(atRest.position) < 0.5 && atRest.velocity === 0, JSON.stringify(atRest))
  const run = testRunsRepo.lastCompleted()
  check('run recorded as COMPLETED with telemetry and cycle times', run?.resultStatus === 'COMPLETED' && testRunsRepo.points(run.id).length > 10 && (run.upCycleSec ?? 0) > 0 && (run.downCycleSec ?? 0) > 0, JSON.stringify(run))
  check('up and down cycle events', cycles.includes('up') && cycles.includes('down'))

  console.log('\nStop and resume')
  await resetMachine()
  await setSpeeds(800, 1000, 50)
  await startRun(request)
  await waitFor(() => snap().heightMm > 600, 5000)
  await stopRun()
  check('STOP halts', await waitFor(() => snap().status === HardwareStatus.HALT, 2000))
  const halted = await sim.waitState((s) => s.velocity === 0, 1000)
  await sleep(400)
  check('position holds while halted', !!halted && Math.abs((await sim.state()).position - halted.position) < 0.01)
  await startRun(request)
  check('RESUME continues raising', await waitFor(() => snap().status === HardwareStatus.PANTO_RAISING, 2000))
  check('resumed run completes', await waitFor(() => snap().status === HardwareStatus.READY, 20000))

  console.log('\nOverload trip (controller side)')
  await resetMachine()
  await startRun(request)
  await waitFor(() => snap().heightMm > 300, 5000)
  sim.send('load 300')
  const tripped = await sim.waitState((s) => s.safetyStop === 'overload', 2000)
  check('controller trips by itself above the overload limit', !!tripped)
  check('motion stops at once', !!(await sim.waitState((s) => s.velocity === 0, 1000)))
  check('app shows OVERLOAD and the latched flag', await waitFor(() => snap().status === HardwareStatus.OVERLOAD && snap().safety.overloadTrip, 2000))
  check('run closed as OVERLOAD', testRunsRepo.lastCompleted()?.resultStatus === HardwareStatus.OVERLOAD)
  sim.send('load auto')
  await sleep(300)
  check('the trip stays latched after the load drops', snap().status === HardwareStatus.OVERLOAD)
  await resetMachine()
  check('RESET clears it', await waitFor(() => snap().status === HardwareStatus.READY && !snap().safety.overloadTrip, 2000), `(${snap().status})`)

  console.log('\nE-stop')
  await rehome()
  await startRun(request)
  await waitFor(() => snap().heightMm > 300, 5000)
  sim.send('estop 1')
  check('EMERGENCY PRESSED at once', await waitFor(() => snap().status === HardwareStatus.EMERGENCY_PRESSED && snap().safety.estop, 1000))
  const stopped = await sim.state()
  check('drive disabled and not moving', !stopped.drive && stopped.velocity === 0, JSON.stringify(stopped))
  await resetMachine()
  await sleep(300)
  check('RESET cannot clear a pressed E-stop', snap().status === HardwareStatus.EMERGENCY_PRESSED)
  sim.send('estop 0')
  await sleep(400)
  const released = await sim.state()
  check('releasing the E-stop restarts nothing', snap().status === HardwareStatus.EMERGENCY_PRESSED && released.velocity === 0 && Math.abs(released.position - stopped.position) < 0.01)
  await resetMachine()
  check('release + RESET recovers', await waitFor(() => snap().status === HardwareStatus.READY, 2000), `(${snap().status})`)

  console.log('\nCommunication watchdog')
  await rehome()
  await setSpeeds(300, 1000, 50)
  await startRun(request)
  await waitFor(() => snap().heightMm > 200, 5000)
  hardware.stopSupervision()
  await hardware.disconnect()
  const silentAt = Date.now()
  const halt = await sim.waitState((s) => s.safetyStop === 'watchdog' && s.status === 5 && s.velocity === 0, 4000)
  check('controller halts within ~2 s when the app goes silent', !!halt && Date.now() - silentAt < 3500, `(${Date.now() - silentAt} ms, ${JSON.stringify(await sim.state())})`)
  await hardware.tryConnect()
  hardware.startSupervision()
  check('app reconnects and sees HALT', await waitFor(() => snap().connected && snap().status === HardwareStatus.HALT, 5000), `(${snap().status})`)
  await resetMachine()

  console.log('\nSoft travel limit (height capacity) and MANUAL jog')
  await rehome()
  await hardware.setHeightCapacity(300)
  sim.send('pendant 1 1')
  await sleep(800)
  sim.send('pendant 0 0')
  check('holding both pendant buttons switches to MANUAL', await waitFor(() => snap().mode === 'MANUAL', 2000))
  await setSpeeds(300, 1000, 200)
  await jogMachine('UP', true)
  const hold = setInterval(() => void jogMachine('UP', true).catch(() => undefined), 200)
  const overTravel = await waitFor(() => snap().status === HardwareStatus.OVER_TRAVEL, 5000)
  clearInterval(hold)
  await jogMachine('UP', false).catch(() => undefined)
  const atLimit = (await sim.waitState((s) => s.velocity === 0, 2000)) ?? (await sim.state())
  check('jogging into the limit trips OVER TRAVEL', overTravel && atLimit.safetyStop === 'travel', `(${snap().status}, ${JSON.stringify(atLimit)})`)
  check('stops at the limit, not past it (200 mm/s jog)', atLimit.position >= 295 && atLimit.position <= 300.05, `(${atLimit.position} mm)`)
  await jogMachine('UP', true).catch(() => undefined)
  await sleep(300)
  await jogMachine('UP', false).catch(() => undefined)
  check('cannot jog further up past a tripped limit', (await sim.state()).position - atLimit.position < 0.5)
  await hardware.setHeightCapacity(4000)
  await resetMachine()
  check('RESET clears OVER TRAVEL', await waitFor(() => snap().status !== HardwareStatus.OVER_TRAVEL, 2000))
  sim.send('pendant 0 1')
  const jogged = await sim.waitState((s) => s.position < atLimit.position - 20, 3000)
  sim.send('pendant 0 0')
  check('pendant DOWN jogs while held', !!jogged)
  check('pendant release stops', !!(await sim.waitState((s) => s.velocity === 0, 1000)))
  sim.send('pendant 1 1')
  await sleep(800)
  sim.send('pendant 0 0')
  check('holding both again returns to AUTO', await waitFor(() => snap().mode === 'AUTO', 2000))

  console.log('\nOver-travel switches and drive alarm')
  sim.send('upper 1')
  check('upper limit switch shows OVER TRAVEL even at rest', await waitFor(() => snap().status === HardwareStatus.OVER_TRAVEL && snap().safety.upperLimit, 2000))
  await expectError('START refused while a limit is tripped', 'ERR_FAULT_ACTIVE', () => startRun(request))
  sim.send('upper 0')
  await resetMachine()
  check('switch released + RESET clears it', await waitFor(() => snap().status !== HardwareStatus.OVER_TRAVEL, 2000))
  sim.send('alarm 1')
  check('drive alarm shows SERVO ERROR', await waitFor(() => snap().status === HardwareStatus.SERVO_ERROR, 2000), `(${snap().status})`)
  check('drive disabled on alarm', !(await sim.state()).drive)
  sim.send('alarm 0')
  await resetMachine()
  check('alarm cleared + RESET recovers', await waitFor(() => snap().status !== HardwareStatus.SERVO_ERROR, 2000))

  console.log('\nLine noise')
  const before = await sim.state()
  sim.send('noise 8')
  await sleep(1000)
  const after = await sim.state()
  check('garbage on the line does not break the link', snap().connected && after.requests > before.requests + 3, `(${before.requests} -> ${after.requests} requests, ${after.crcErrors} CRC errors)`)

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
