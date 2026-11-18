import { EventEmitter } from 'events'
import {
  ErrorCode,
  type ModelConfig,
  type PlcState,
  type S7Bit,
  type S7Command,
  type S7Connection,
  type S7Map,
  type SpeedSettings
} from '@shared/types'
import { CommandError } from '../errors'
import { log } from '../logger'
import {
  delay,
  disconnectedState,
  messageOf,
  parseStatusString,
  type HardwareInterface
} from './HardwareInterface'
import { getS7String, realBytes, S7Client } from './s7/S7Client'

/** Consecutive failed polls before the link is declared down. */
const MAX_POLL_FAILURES = 3

/**
 * Talks to the machine's Siemens PLC: polls the status STRING in the data
 * block (DB6.DBB1866 by default) and sets command bits in the same block.
 */
export class S7Hardware extends EventEmitter implements HardwareInterface {
  private client: S7Client | null = null
  private connected = false
  private pollTimer: NodeJS.Timeout | null = null
  private pollFailures = 0
  private last: PlcState = disconnectedState()

  constructor(
    private readonly connection: S7Connection,
    private readonly map: S7Map,
    /** Connection test: read only, never writes. */
    private readonly probeOnly = false
  ) {
    super()
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const c = this.connection
    const client = new S7Client({
      host: c.host,
      port: c.port,
      rack: c.rack,
      slot: c.slot,
      timeoutMs: c.timeoutMs
    })
    try {
      await client.connect()
      this.client = client
      await this.pollOnce()
    } catch (error) {
      client.close()
      this.client = null
      throw new CommandError(ErrorCode.CONNECTION_FAILED, `${describe(c)}: ${messageOf(error)}`)
    }
    client.onClosed((reason) => {
      if (this.client === client) this.dropLink(reason)
    })
    this.connected = true
    this.pollFailures = 0
    if (this.probeOnly) return
    log.info(`S7 connected (${describe(c)}, DB${this.map.dbNumber})`)
    this.emit('connection', true)
    this.schedulePoll()
  }

  async disconnect(): Promise<void> {
    this.dropLink('disconnect requested')
  }

  private dropLink(reason: string): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    const was = this.connected
    this.connected = false
    this.client?.close()
    this.client = null
    this.last = disconnectedState(this.last)
    if (was && !this.probeOnly) {
      log.warn(`S7 link down: ${reason}`)
      this.emit('connection', false)
      this.emit('state', this.last)
    }
  }

  // -------------------------------------------------------------------------
  // Commands: bits and REAL values in the data block
  // -------------------------------------------------------------------------

  async start(model: ModelConfig): Promise<void> {
    const { writes, commands } = this.map
    if (writes.distance !== null) await this.writeReal(writes.distance, model.distanceMm)
    await this.writeBit(commands.stop, false)
    await this.command(commands.start)
  }

  async stop(): Promise<void> {
    await this.writeBit(this.map.commands.stop, true)
  }

  async reset(): Promise<void> {
    await this.command(this.map.commands.reset)
  }

  async home(): Promise<void> {
    await this.command(this.map.commands.home)
  }

  async writeSpeeds(speeds: SpeedSettings): Promise<void> {
    if (!this.client) return
    const { upSpeed, downSpeed, jogSpeed } = this.map.writes
    if (upSpeed !== null) await this.writeReal(upSpeed, speeds.up)
    if (downSpeed !== null) await this.writeReal(downSpeed, speeds.down)
    if (jogSpeed !== null) await this.writeReal(jogSpeed, speeds.jog)
  }

  getState(): PlcState {
    return this.last
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private schedulePoll(): void {
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollOnce()
        this.pollFailures = 0
      } catch (error) {
        if (!this.connected) return
        this.pollFailures++
        log.warn(`S7 poll failed (${this.pollFailures}/${MAX_POLL_FAILURES}): ${messageOf(error)}`)
        if (this.pollFailures >= MAX_POLL_FAILURES) {
          this.dropLink(messageOf(error))
          return
        }
      }
      if (this.connected) this.schedulePoll()
    }, this.connection.pollIntervalMs)
  }

  private async pollOnce(): Promise<void> {
    const client = this.requireClient()
    const { dbNumber, statusString, loadDivisor } = this.map
    const data = await client.dbRead(dbNumber, statusString.offset, statusString.maxLength + 2)
    const text = getS7String(data, 0)
    const parsed = parseStatusString(text, loadDivisor)
    // Polls whose string does not split into six values are skipped.
    if (!parsed) return
    this.last = { connected: true, timestampMs: Date.now(), ...parsed }
    if (this.connected && !this.probeOnly) this.emit('state', this.last)
  }

  // -------------------------------------------------------------------------
  // Low-level writes
  // -------------------------------------------------------------------------

  private requireClient(): S7Client {
    if (!this.client) throw new CommandError(ErrorCode.HARDWARE_DISCONNECTED)
    return this.client
  }

  private async guarded(task: () => Promise<void>): Promise<void> {
    if (this.probeOnly) return
    try {
      await task()
    } catch (error) {
      if (error instanceof CommandError) throw error
      throw new CommandError(ErrorCode.CONNECTION_FAILED, `Machine did not respond (${messageOf(error)})`)
    }
  }

  private writeBit(address: S7Bit, value: boolean): Promise<void> {
    return this.guarded(() =>
      this.requireClient().dbWriteBit(this.map.dbNumber, address.byte, address.bit, value)
    )
  }

  private writeReal(offset: number, value: number): Promise<void> {
    return this.guarded(() => this.requireClient().dbWrite(this.map.dbNumber, offset, realBytes(value)))
  }

  private async command(spec: S7Command): Promise<void> {
    await this.writeBit(spec, true)
    if (spec.pulseMs > 0) {
      await delay(spec.pulseMs)
      await this.writeBit(spec, false)
    }
  }
}

function describe(c: S7Connection): string {
  return `S7 ${c.host}:${c.port} rack ${c.rack} slot ${c.slot}`
}
