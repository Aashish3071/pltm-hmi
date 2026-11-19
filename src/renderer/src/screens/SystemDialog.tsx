import { useEffect, useState } from 'react'
import type { HardwareConfig, HardwareDriver, MachineSettings, ModbusConnection, S7Connection, SerialPortInfo } from '@shared/types'
import { api, unwrap } from '../api/client'

/**
 * Admin-only system settings: the PLC connection (Siemens S7 or Modbus), the
 * machine and company details printed on reports, and the report folder.
 */
export default function SystemDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [config, setConfig] = useState<HardwareConfig | null>(null)
  const [s7Map, setS7Map] = useState('')
  const [modbusMap, setModbusMap] = useState('')
  const [machine, setMachine] = useState<MachineSettings | null>(null)
  const [reportDir, setReportDir] = useState('')
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const [hw, settings] = await Promise.all([unwrap(api.hardware.getConfig()), unwrap(api.settings.get())])
      setConfig(hw)
      setS7Map(JSON.stringify(hw.s7.map, null, 2))
      setModbusMap(JSON.stringify(hw.modbus.map, null, 2))
      setMachine(settings.machine)
      setReportDir(settings.reportDir)
    })()
    const refresh = (): void => void api.hardware.listPorts().then((r) => r.ok && setPorts(r.data))
    refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => window.clearInterval(timer)
  }, [])

  if (!config || !machine) {
    return (
      <div className="modal-backdrop">
        <div className="dialog sys">
          <div className="dialog-head">SYSTEM</div>
          <div className="dialog-body">Loading…</div>
        </div>
      </div>
    )
  }

  const s7 = config.s7.connection
  // The controller and a generic Modbus PLC share the connection fields.
  const link = config.driver === 'controller' ? 'controller' : 'modbus'
  const mb = config[link].connection
  const setS7 = (patch: Partial<S7Connection>): void =>
    setConfig({ ...config, s7: { ...config.s7, connection: { ...s7, ...patch } } })
  const setMb = (patch: Partial<ModbusConnection>): void =>
    setConfig(
      link === 'controller'
        ? { ...config, controller: { connection: { ...mb, ...patch } } }
        : { ...config, modbus: { ...config.modbus, connection: { ...mb, ...patch } } }
    )
  const num = (v: string): number => Number(v)

  const assembled = (): HardwareConfig => ({
    ...config,
    s7: { ...config.s7, map: JSON.parse(s7Map) },
    modbus: { ...config.modbus, map: JSON.parse(modbusMap) }
  })

  const act = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      setResult({ ok: true, text: await fn() })
    } catch (error) {
      setResult({ ok: false, text: (error as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const test = (): Promise<void> =>
    act(async () => {
      const r = await unwrap(api.hardware.testConnection(assembled()))
      return `Connected. Status: ${r.status} · Load ${r.loadN} N · Position ${r.positionMm} mm`
    })

  const save = (): Promise<void> =>
    act(async () => {
      const saved = await unwrap(api.hardware.setConfig(assembled()))
      setConfig(saved)
      await unwrap(api.settings.setMachine(machine))
      await unwrap(api.settings.setReportDir(reportDir))
      return `Saved. Driver: ${label(saved.driver)}.`
    })

  return (
    <div className="modal-backdrop">
      <div className="dialog sys" role="dialog" aria-label="SYSTEM" data-testid="system-dialog">
        <div className="dialog-head">
          SYSTEM — machine connection and report details
          <button className="x" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className="dialog-body">
          <fieldset>
            <legend>PLC connection</legend>
            <div className="grid">
              <span>Driver</span>
              <select className="input"
                value={config.driver}
                onChange={(e) => setConfig({ ...config, driver: e.target.value as HardwareDriver })}
                data-testid="sys-driver"
              >
                <option value="s7">Siemens S7 (Ethernet)</option>
                <option value="controller">PantoCheck controller (Modbus RTU)</option>
                <option value="modbus">Other Modbus PLC (RTU / TCP)</option>
                <option value="simulator">Simulator (no machine)</option>
              </select>
            </div>
            {config.driver === 's7' && (
              <>
                <div className="grid">
                  <span>PLC IP address / port</span>
                  <input className="input" value={s7.host} onChange={(e) => setS7({ host: e.target.value })} data-testid="sys-s7-host" />
                  <input className="input" value={s7.port} onChange={(e) => setS7({ port: num(e.target.value) })} />
                                  </div>
                <div className="grid">
                  <span>Rack / slot</span>
                  <input className="input" value={s7.rack} onChange={(e) => setS7({ rack: num(e.target.value) })} />
                  <input className="input" value={s7.slot} onChange={(e) => setS7({ slot: num(e.target.value) })} />
                                  </div>
                <div className="grid">
                  <span>Poll / timeout (ms)</span>
                  <input className="input" value={s7.pollIntervalMs} onChange={(e) => setS7({ pollIntervalMs: num(e.target.value) })} />
                  <input className="input" value={s7.timeoutMs} onChange={(e) => setS7({ timeoutMs: num(e.target.value) })} />
                                  </div>
                <p className="note">
                  Data block addresses (default: DB6). In TIA Portal the data block must have optimized access
                  off and PUT/GET must be allowed.
                </p>
                <textarea rows={10} value={s7Map} onChange={(e) => setS7Map(e.target.value)} spellCheck={false} />
              </>
            )}
            {(config.driver === 'modbus' || config.driver === 'controller') && (
              <>
                <div className="grid">
                  <span>Transport</span>
                  <select className="input" value={mb.transport} onChange={(e) => setMb({ transport: e.target.value as ModbusConnection['transport'] })}>
                    <option value="rtu-serial">Modbus RTU — COM port (USB-RS485)</option>
                    <option value="rtu-tcp">Modbus RTU over TCP (gateway)</option>
                    <option value="tcp">Modbus TCP</option>
                  </select>
                </div>
                {mb.transport === 'rtu-serial' ? (
                  <>
                    <div className="grid">
                      <span>COM port</span>
                      <input className="input"
                        list="ports"
                        style={{ gridColumn: 'span 3' }}
                        value={mb.serialPath}
                        onChange={(e) => setMb({ serialPath: e.target.value })}
                        placeholder="COM3"
                      />
                      <datalist id="ports">
                        {ports.map((p) => (
                          <option key={p.path} value={p.path}>
                            {[p.chip, p.manufacturer].filter(Boolean).join(' · ')}
                          </option>
                        ))}
                      </datalist>
                    </div>
                    <div className="grid">
                      <span>Baud / parity</span>
                      <select className="input" value={mb.baudRate} onChange={(e) => setMb({ baudRate: num(e.target.value) })}>
                        {[1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map((b) => (
                          <option key={b}>{b}</option>
                        ))}
                      </select>
                      <select className="input" value={mb.parity} onChange={(e) => setMb({ parity: e.target.value as ModbusConnection['parity'] })}>
                        <option value="none">None</option>
                        <option value="even">Even</option>
                        <option value="odd">Odd</option>
                      </select>
                                          </div>
                    <div className="grid">
                      <span>Data / stop bits</span>
                      <select className="input" value={mb.dataBits} onChange={(e) => setMb({ dataBits: num(e.target.value) as 7 | 8 })}>
                        <option>8</option>
                        <option>7</option>
                      </select>
                      <select className="input" value={mb.stopBits} onChange={(e) => setMb({ stopBits: num(e.target.value) as 1 | 2 })}>
                        <option>1</option>
                        <option>2</option>
                      </select>
                                          </div>
                  </>
                ) : (
                  <div className="grid">
                    <span>IP address / port</span>
                    <input className="input" value={mb.host} onChange={(e) => setMb({ host: e.target.value })} />
                    <input className="input" value={mb.port} onChange={(e) => setMb({ port: num(e.target.value) })} />
                                      </div>
                )}
                <div className="grid">
                  <span>Slave ID / poll / timeout</span>
                  <input className="input" value={mb.unitId} onChange={(e) => setMb({ unitId: num(e.target.value) })} />
                  <input className="input" value={mb.pollIntervalMs} onChange={(e) => setMb({ pollIntervalMs: num(e.target.value) })} />
                  <input className="input" value={mb.timeoutMs} onChange={(e) => setMb({ timeoutMs: num(e.target.value) })} />
                </div>
                {config.driver === 'controller' ? (
                  <p className="note">
                    The controller firmware (firmware/pltm-controller) uses a fixed register layout. It stops motion if this
                    app stops talking to it for 2 seconds.
                  </p>
                ) : (
                  <p className="note">Register map — load, position, status code, times, mode; command coils; speed registers.</p>
                )}
                {config.driver === 'modbus' && (
                  <textarea rows={10} value={modbusMap} onChange={(e) => setModbusMap(e.target.value)} spellCheck={false} />
                )}
              </>
            )}
            {result && (
              <div className={`result ${result.ok ? 'ok' : 'bad'}`} data-testid="sys-result">
                {result.text}
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend>Machine</legend>
            <div className="grid">
              <span>Machine ID</span>
              <input className="input" value={machine.machineId} onChange={(e) => setMachine({ ...machine, machineId: e.target.value })} />
            </div>
            <div className="grid">
              <span>Load (kg) / height (mm) capacity</span>
              <input className="input"
                value={machine.loadCapacityKg}
                onChange={(e) => setMachine({ ...machine, loadCapacityKg: num(e.target.value) })}
              />
              <input className="input"
                value={machine.heightCapacityMm}
                onChange={(e) => setMachine({ ...machine, heightCapacityMm: num(e.target.value) })}
              />
                          </div>
          </fieldset>

          <fieldset>
            <legend>Report</legend>
            <div className="grid">
              <span>Company name</span>
              <input className="input"
                value={machine.company.name}
                onChange={(e) => setMachine({ ...machine, company: { ...machine.company, name: e.target.value } })}
                data-testid="sys-company"
              />
            </div>
            <div className="grid">
              <span>Address line 1</span>
              <input className="input"
                value={machine.company.addressLine1}
                onChange={(e) => setMachine({ ...machine, company: { ...machine.company, addressLine1: e.target.value } })}
              />
            </div>
            <div className="grid">
              <span>Address line 2</span>
              <input className="input"
                value={machine.company.addressLine2}
                onChange={(e) => setMachine({ ...machine, company: { ...machine.company, addressLine2: e.target.value } })}
              />
            </div>
            <div className="grid">
              <span>Speed of meas. text</span>
              <input className="input"
                value={machine.measurementSpeedText}
                placeholder="(the up speed, e.g. 50mm/s)"
                onChange={(e) => setMachine({ ...machine, measurementSpeedText: e.target.value })}
              />
            </div>
            <div className="grid">
              <span>Report folder</span>
              <input className="input" value={reportDir} onChange={(e) => setReportDir(e.target.value)} style={{ gridColumn: 'span 2' }} />
              <button className="btn ghost" onClick={() => void api.settings.pickReportDir().then((r) => r.ok && setReportDir(r.data))}>Browse…</button>
            </div>
          </fieldset>
        </div>
        <div className="actions">
          {config.driver !== 'simulator' && (
            <button className="btn ghost" onClick={() => void test()} disabled={busy} data-testid="sys-test">
              TEST CONNECTION
            </button>
          )}
          <button className="btn" onClick={() => void save()} disabled={busy} data-testid="sys-save">
            SAVE
          </button>
          <button className="btn ghost" onClick={onClose} data-testid="sys-close">
            CLOSE
          </button>
        </div>
      </div>
    </div>
  )
}

function label(driver: HardwareDriver): string {
  return driver === 's7' ? 'Siemens S7' : driver === 'controller' ? 'PantoCheck controller' : driver === 'modbus' ? 'Modbus' : 'Simulator'
}
