import { useEffect, useState } from 'react'
import type {
  HardwareConfig,
  HardwareDriver,
  ModbusConnection,
  ModbusTransport,
  SerialPortInfo
} from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'

interface Props {
  onApplied: () => void
}

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]
const PORT_REFRESH_MS = 3000
const MANUAL_PORT = '__manual__'

/** Mirrors the main process check; the map may be raw JSON from the editor. */
function missingSafety(map: unknown): string[] {
  const m = (map ?? {}) as {
    safety?: Record<string, unknown>
    writes?: Record<string, unknown>
  }
  const safety = m.safety ?? {}
  const writes = m.writes ?? {}
  const missing: string[] = []
  if (!safety.estop) missing.push('emergency stop (safety.estop)')
  if (!safety.overloadTrip && !writes.overloadLimit) missing.push('PLC overload trip')
  if (!safety.heartbeat) missing.push('communication watchdog (safety.heartbeat)')
  if (!safety.upperLimit && !writes.travelLimit) missing.push('over-travel limit')
  return missing
}

function portLabel(port: SerialPortInfo): string {
  const maker = port.chip ? `${port.chip} USB adapter` : port.manufacturer
  return maker ? `${port.path} — ${maker}` : port.path
}

export default function ConnectionPanel({ onApplied }: Props): JSX.Element {
  const [config, setConfig] = useState<HardwareConfig | null>(null)
  const [mapText, setMapText] = useState('')
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const [testResult, setTestResult] = useState('')
  const [manualPort, setManualPort] = useState(false)

  const loadPorts = async (): Promise<void> => {
    const result = await api.hardware.listPorts()
    if (result.ok) setPorts(result.data)
  }

  useEffect(() => {
    void (async () => {
      const result = await api.hardware.getConfig()
      if (result.ok) {
        setConfig(result.data)
        setMapText(JSON.stringify(result.data.registerMap, null, 2))
      } else {
        toast.error(result.message)
      }
    })()
  }, [])

  // Adapters get plugged in during commissioning: keep the list current.
  const transport = config?.connection.transport
  useEffect(() => {
    if (transport !== 'rtu-serial') return
    void loadPorts()
    const timer = window.setInterval(() => void loadPorts(), PORT_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [transport])

  if (!config) return <div className="panel orange">Loading…</div>

  const conn = config.connection
  const setConn = (patch: Partial<ModbusConnection>): void =>
    setConfig({ ...config, connection: { ...conn, ...patch } })
  const num = (value: string): number => (value.trim() === '' ? NaN : Number(value))

  /** Parses the register map text; reports JSON syntax errors to the operator. */
  const buildConfig = (driver: HardwareDriver): HardwareConfig | null => {
    try {
      return { ...config, driver, registerMap: JSON.parse(mapText) }
    } catch (error) {
      toast.error(`Register map is not valid JSON: ${(error as Error).message}`)
      return null
    }
  }

  const test = async (): Promise<void> => {
    const candidate = buildConfig('modbus')
    if (!candidate) return
    setBusy('test')
    setTestResult('')
    const result = await api.hardware.testConnection(candidate)
    setBusy(null)
    if (result.ok) {
      const r = result.data
      setTestResult(`Connected. Status ${r.status}, load ${r.loadN} N, position ${r.heightMm} mm.`)
      toast.success('Connection test passed.')
    } else {
      setTestResult(result.message)
      toast.error(result.message)
    }
  }

  const save = async (): Promise<void> => {
    const candidate = buildConfig(config.driver)
    if (!candidate) return
    const missing = candidate.driver === 'modbus' ? missingSafety(candidate.registerMap) : []
    const safetyNote = missing.length
      ? `\n\nThe map does not connect these PLC safety functions, so the app cannot show them:\n• ${missing.join('\n• ')}\nSee docs/plc-safety-requirements.md.`
      : ''
    if (
      candidate.driver === 'modbus' &&
      !window.confirm(
        `Switch to the real machine over Modbus?\n\nMake sure the register map has been checked against the PLC program. Wrong addresses can command the machine unexpectedly.${safetyNote}`
      )
    ) {
      return
    }
    setBusy('save')
    const result = await api.hardware.setConfig(candidate)
    setBusy(null)
    if (result.ok) {
      setConfig(result.data)
      setMapText(JSON.stringify(result.data.registerMap, null, 2))
      toast.success(
        result.data.driver === 'modbus' ? 'Modbus driver applied. Connecting…' : 'Simulator applied.'
      )
      onApplied()
    } else {
      toast.error(result.message)
    }
  }

  const modbus = config.driver === 'modbus'
  const serial = conn.transport === 'rtu-serial'

  return (
    <div className="panel orange connection-panel">
      <div className="section-title">
        <span className="glyph">&#128268;</span> MACHINE CONNECTION
      </div>

      <div className="field-row">
        <label>DRIVER</label>
        <select
          value={config.driver}
          onChange={(e) => setConfig({ ...config, driver: e.target.value as HardwareDriver })}
        >
          <option value="simulator">Simulator (no machine)</option>
          <option value="modbus">Modbus (real machine)</option>
        </select>
      </div>

      <div className="field-row">
        <label>PROTOCOL</label>
        <select
          value={conn.transport}
          onChange={(e) => setConn({ transport: e.target.value as ModbusTransport })}
        >
          <option value="rtu-serial">Modbus RTU — serial COM port</option>
          <option value="rtu-tcp">Modbus RTU over TCP (gateway)</option>
          <option value="tcp">Modbus TCP</option>
        </select>
      </div>

      {serial ? (
        <>
          <div className="field-row">
            <label>COM PORT</label>
            <div className="port-picker">
              <select
                aria-label="COM port"
                value={manualPort ? MANUAL_PORT : conn.serialPath}
                onChange={(e) => {
                  if (e.target.value === MANUAL_PORT) {
                    setManualPort(true)
                  } else {
                    setManualPort(false)
                    setConn({ serialPath: e.target.value })
                  }
                }}
              >
                {ports.length === 0 && !conn.serialPath && <option value="">No COM ports found</option>}
                {conn.serialPath && !ports.some((p) => p.path === conn.serialPath) && (
                  <option value={conn.serialPath}>{conn.serialPath} (not plugged in)</option>
                )}
                {ports.map((p) => (
                  <option key={p.path} value={p.path}>
                    {portLabel(p)}
                  </option>
                ))}
                <option value={MANUAL_PORT}>Other — type the port name…</option>
              </select>
              <button className="btn small" onClick={() => void loadPorts()} title="Search for COM ports again">
                &#8635;
              </button>
            </div>
          </div>
          {manualPort && (
            <div className="field-row">
              <label>PORT NAME</label>
              <input
                placeholder="e.g. COM7"
                value={conn.serialPath}
                onChange={(e) => setConn({ serialPath: e.target.value.trim() })}
              />
            </div>
          )}
          <div className="hint" style={{ marginTop: -2, marginBottom: 6 }}>
            {ports.length === 0
              ? 'No COM ports found. Plug in the USB-RS485 adapter and install its driver; this list updates by itself.'
              : `${ports.length} COM port${ports.length === 1 ? '' : 's'} found. Unplug and replug the adapter to see which one is yours.`}
          </div>
          <div className="field-row">
            <label>BAUD RATE</label>
            <select value={conn.baudRate} onChange={(e) => setConn({ baudRate: Number(e.target.value) })}>
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <label>DATA / PARITY / STOP</label>
            <div className="framing">
              <select
                value={conn.dataBits}
                onChange={(e) => setConn({ dataBits: Number(e.target.value) as 7 | 8 })}
              >
                <option value={8}>8</option>
                <option value={7}>7</option>
              </select>
              <select
                value={conn.parity}
                onChange={(e) => setConn({ parity: e.target.value as ModbusConnection['parity'] })}
              >
                <option value="none">None</option>
                <option value="even">Even</option>
                <option value="odd">Odd</option>
              </select>
              <select
                value={conn.stopBits}
                onChange={(e) => setConn({ stopBits: Number(e.target.value) as 1 | 2 })}
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="field-row">
            <label>IP ADDRESS</label>
            <input value={conn.host} onChange={(e) => setConn({ host: e.target.value.trim() })} />
          </div>
          <div className="field-row">
            <label>PORT</label>
            <input inputMode="numeric" value={Number.isNaN(conn.port) ? '' : conn.port} onChange={(e) => setConn({ port: num(e.target.value) })} />
          </div>
        </>
      )}

      <div className="field-row">
        <label>SLAVE ID</label>
        <input inputMode="numeric" value={Number.isNaN(conn.unitId) ? '' : conn.unitId} onChange={(e) => setConn({ unitId: num(e.target.value) })} />
      </div>
      <div className="field-row">
        <label>TIMEOUT (ms)</label>
        <input inputMode="numeric" value={Number.isNaN(conn.timeoutMs) ? '' : conn.timeoutMs} onChange={(e) => setConn({ timeoutMs: num(e.target.value) })} />
      </div>
      <div className="field-row">
        <label>POLL EVERY (ms)</label>
        <input
          inputMode="numeric"
          value={Number.isNaN(conn.pollIntervalMs) ? '' : conn.pollIntervalMs}
          onChange={(e) => setConn({ pollIntervalMs: num(e.target.value) })}
        />
      </div>

      <div className="section-title" style={{ marginTop: 10 }}>
        REGISTER MAP (JSON)
      </div>
      <textarea
        className="register-map"
        spellCheck={false}
        value={mapText}
        onChange={(e) => setMapText(e.target.value)}
      />
      <div className="hint">
        The default map is a placeholder. Enter the addresses from the PLC programmer before
        using the real machine. Commands with <code>pulseMs</code> are written then cleared;
        values are scaled as raw × <code>scale</code>.
      </div>

      {testResult && <div className="test-result">{testResult}</div>}

      <div className="settings-actions">
        <button className="btn small" onClick={test} disabled={busy !== null}>
          {busy === 'test' ? 'TESTING…' : 'TEST CONNECTION'}
        </button>
        <button className="btn yellow small" onClick={save} disabled={busy !== null}>
          {busy === 'save' ? 'APPLYING…' : 'SAVE & APPLY'}
        </button>
      </div>
      {modbus && (
        <div className="hint warn">
          Real-machine mode: START, STOP, HOMING and jog commands are sent to the PLC.
        </div>
      )}
    </div>
  )
}
