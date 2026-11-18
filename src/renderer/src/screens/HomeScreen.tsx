import { useEffect, useMemo, useRef, useState } from 'react'
import { ALARM_CODES, StatusCode, statusText, type SpeedSettings, type TestResults } from '@shared/types'
import { computeResults, formatResult, sortedPoints } from '@shared/analysis'
import { api, unwrap } from '../api/client'
import { Header } from '../components/Header'
import { Icon } from '../components/Icons'
import { critical, information } from '../components/MessageBox'
import { CURVE_COLORS, plotPng, PlotView } from '../components/Plot'
import { currentModel, refreshModelsAndSelection, useMachine } from '../state/machine'
import AdminDialog from './AdminDialog'

type Shown = { avgUp: string; avgDown: string; mean: string; peak: string; hyst: string; height: string }
const ZERO: Shown = { avgUp: '0', avgDown: '0', mean: '0', peak: '0', hyst: '0', height: '0' }
const DASHES: Shown = { avgUp: '-----', avgDown: '-----', mean: '-----', peak: '-----', hyst: '-----', height: '-----' }
const BUSY_CODES: number[] = [
  StatusCode.PANTO_RAISING,
  StatusCode.PANTO_RAISING_COMPLETED,
  StatusCode.PANTO_RETRIEVING,
  StatusCode.CYCLE_COMPLETED
]

function shown(r: TestResults): Shown {
  return {
    avgUp: formatResult(r.avgUpN),
    avgDown: formatResult(r.avgDownN),
    mean: formatResult(r.meanN),
    peak: formatResult(r.peakFrictionN),
    hyst: formatResult(r.hysteresisN),
    height: String(r.maxHeightMm)
  }
}

function Reading({ label, unit, value, testId }: { label: string; unit?: string; value: string; testId: string }): JSX.Element {
  return (
    <>
      <label>
        {label} {unit && <span className="unit">({unit})</span>}
      </label>
      <div className="value" data-testid={testId}>
        {value}
      </div>
    </>
  )
}

export default function HomeScreen({
  onSettings,
  onLogout,
  onClose
}: {
  onSettings: () => void
  onLogout: () => void
  onClose: () => void
}): JSX.Element {
  const state = useMachine((s) => s.state)
  const tick = useMachine((s) => s.tick)
  const historyVersion = useMachine((s) => s.historyVersion)
  const { n, n1, n2 } = useMachine.getState()
  const user = useMachine((s) => s.user)
  const models = useMachine((s) => s.models)
  const selection = useMachine((s) => s.selection)
  const [modelId, setModelId] = useState(0)
  const [partNo, setPartNo] = useState('')
  const [speeds, setSpeeds] = useState<SpeedSettings | null>(null)
  const [checks, setChecks] = useState({ n: true, n1: false, n2: false })
  const [results, setResults] = useState<Shown>(ZERO)
  const [busy, setBusy] = useState(false)
  const [admin, setAdmin] = useState(false)
  const first = useRef(true)

  useEffect(() => {
    void refreshModelsAndSelection().then(() => {
      const sel = useMachine.getState().selection
      if (sel) {
        setModelId(sel.modelId)
        setPartNo(sel.partNo)
      }
    })
    void api.settings.get().then((r) => r.ok && setSpeeds(r.data.speeds))
  }, [])

  const model = useMemo(() => currentModel(), [models, selection])
  const travel = model ? (sortedPoints(model)[3]?.heightMm ?? model.distanceMm) : 0
  const code = state.connected ? state.code : StatusCode.ETHERNET_DISCONNECTED
  const halted = code === StatusCode.HALT

  // Results refresh at READY and CYCLE COMPLETED, from the one curve shown.
  useEffect(() => {
    const checked = [checks.n, checks.n1, checks.n2].filter(Boolean).length
    const refresh = code === StatusCode.READY || code === StatusCode.CYCLE_COMPLETED || first.current
    first.current = false
    if (checked > 1) {
      setResults(DASHES)
      return
    }
    if (!refresh) return
    const data = checks.n ? n : checks.n1 ? n1 : checks.n2 ? n2 : []
    setResults(data.length ? shown(computeResults(data, model)) : ZERO)
  }, [code, checks, historyVersion, model, code === StatusCode.CYCLE_COMPLETED ? tick : 0])

  const heightShown = code === StatusCode.PANTO_RAISING_COMPLETED ? String(state.positionMm) : results.height

  const run = async (title: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error) {
      await critical(title, (error as Error).message)
    }
  }

  const ok = async (): Promise<void> => {
    const id = modelId || models[0]?.id
    if (!id) return
    await run('Model', async () => {
      const sel = await unwrap(api.machine.select(id, partNo))
      useMachine.getState().setSelection(sel)
      setPartNo(sel.partNo)
    })
  }

  const report = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const st = useMachine.getState()
      const png = plotPng({ model, n: checks.n ? st.n : null, n1: checks.n1 ? st.n1 : null, n2: checks.n2 ? st.n2 : null })
      const files = await unwrap(api.reports.generate(png))
      const name = files.pdfPath.split(/[\\/]/).pop()?.replace(/\.pdf$/, '') ?? ''
      await information('Report saved', `Report generated:\n${name} (.xlsx, .pdf, .json)`)
    } catch (error) {
      await critical('Report', `Could not generate the report: ${(error as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const statusClass = !state.connected || [1, 11, 21, 31].includes(code)
    ? 'fault'
    : code === StatusCode.HOMING_NOT_DONE || halted
      ? 'warn'
      : BUSY_CODES.includes(code)
        ? 'busy'
        : ''

  return (
    <div className="screen">
      <Header title="Static contact force test">
        <div className="who">
          <Icon name="user" size={18} /> <span data-testid="f-employee-head">{user?.displayName}</span>
        </div>
      </Header>
      <div className="body" style={{ gridTemplateColumns: '540px 1fr', gridTemplateRows: '128px 1fr auto auto' }}>
        <div className="card" style={{ gridRow: '1 / span 4' }}>
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span>Load vs height</span>
            <div className="curves">
              {(['n', 'n1', 'n2'] as const).map((key, i) => (
                <button
                  key={key}
                  type="button"
                  className={`curve ${checks[key] ? 'on' : ''}`}
                  aria-pressed={checks[key]}
                  onClick={() => setChecks({ ...checks, [key]: !checks[key] })}
                  data-testid={`chk-${key}`}
                >
                  <span className="swatch" style={{ background: CURVE_COLORS[key] }} />
                  {['n', 'n-1', 'n-2'][i]}
                </button>
              ))}
            </div>
          </div>
          <PlotView
            data={{ model, n: checks.n ? n : null, n1: checks.n1 ? n1 : null, n2: checks.n2 ? n2 : null }}
            testId="graph"
          />
        </div>

        <div className="card status" style={{ padding: 10 }}>
          <div className={`status-main ${statusClass}`}>
            <div className="status-row">
              <div className="status-text" data-testid="status">
                {statusText(state)}
              </div>
              <div className={`bell ${ALARM_CODES.includes(code) ? 'on' : ''}`} title="Alarm">
                <Icon name="bell" />
              </div>
            </div>
            <div className="pills">
              <span className={`pill ${state.mode === 'AUTO' ? 'on' : ''}`} data-testid="mode-auto">
                AUTO MODE
              </span>
              <span className={`pill ${state.mode === 'MANUAL' ? 'on' : ''}`} data-testid="mode-manual">
                MANUAL MODE
              </span>
            </div>
          </div>
          <div className="timers">
            <div className="timer up">
              <span className="arrow">
                <Icon name="up" size={18} />
              </span>
              <span className="t-label">Raising</span>
              <span className="t-value" data-testid="lcd-up" data-value={state.upTimeSec}>
                {state.upTimeSec}
              </span>
              <span className="t-unit">s</span>
            </div>
            <div className="timer down">
              <span className="arrow">
                <Icon name="down" size={18} />
              </span>
              <span className="t-label">Lowering</span>
              <span className="t-value" data-testid="lcd-down" data-value={state.downTimeSec}>
                {state.downTimeSec}
              </span>
              <span className="t-unit">s</span>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, minHeight: 0 }}>
          <div className="card">
            <div className="card-title">
              <Icon name="gauge" size={16} /> Machine readings
            </div>
            <div className="kv">
              <Reading label="Max Height" unit="mm" value={travel ? String(travel) : ''} testId="f-maxheight" />
              <Reading label="Load Value" unit="N" value={String(state.loadN)} testId="f-load" />
              <Reading label="Panto Position" unit="mm" value={String(state.positionMm)} testId="f-position" />
              <Reading label="Up Speed" unit="mm/s" value={speeds ? String(speeds.up) : ''} testId="f-upspeed" />
              <Reading label="Down Speed" unit="mm/s" value={speeds ? String(speeds.down) : ''} testId="f-downspeed" />
              <Reading label="Jog Speed" unit="mm/s" value={speeds ? String(speeds.jog) : ''} testId="f-jogspeed" />
            </div>
          </div>
          <div className="card">
            <div className="card-title">
              <Icon name="report" size={16} /> Test results
            </div>
            <div className="kv">
              <Reading label="Avg up force" unit="N" value={results.avgUp} testId="r-avgup" />
              <Reading label="Avg down force" unit="N" value={results.avgDown} testId="r-avgdown" />
              <Reading label="Mean force" unit="N" value={results.mean} testId="r-mean" />
              <Reading label="Peak friction" unit="N" value={results.peak} testId="r-peak" />
              <Reading label="Hysteresis" unit="N" value={results.hyst} testId="r-hyst" />
              <Reading label="Height reached" unit="mm" value={heightShown} testId="r-height" />
            </div>
          </div>
        </div>

        <div className="card" style={{ padding: '10px 14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1.2fr auto 1fr auto auto', gap: 8, alignItems: 'center' }}>
            <label style={{ fontWeight: 600 }}>Employee</label>
            <input className="input" value={user?.displayName ?? ''} readOnly data-testid="f-employee" />
            <label style={{ fontWeight: 600 }}>Model</label>
            <select className="input" value={modelId || ''} onChange={(e) => setModelId(Number(e.target.value))} data-testid="f-model">
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <label style={{ fontWeight: 600 }}>Part-No</label>
            <input
              className="input"
              placeholder="Enter"
              value={partNo}
              onChange={(e) => setPartNo(e.target.value)}
              data-testid="f-partno"
            />
            <button className="btn" onClick={() => void ok()} data-testid="btn-ok">
              OK
            </button>
            <button className="btn ghost" onClick={() => setPartNo('')} data-testid="btn-clear">
              CLEAR
            </button>
          </div>
        </div>

        <div className="ops">
          <button className="op start" onClick={() => void run('START', () => unwrap(api.machine.start()))} data-testid="btn-start">
            <Icon name="start" /> START
          </button>
          {halted ? (
            <button className="op resume" onClick={() => void run('RESUME', () => unwrap(api.machine.start()))} data-testid="btn-stop">
              <Icon name="resume" /> RESUME
            </button>
          ) : (
            <button
              className="op stop"
              onMouseDown={() => void run('STOP', () => unwrap(api.machine.stop()))}
              data-testid="btn-stop"
            >
              <Icon name="stop" /> STOP
            </button>
          )}
          <button className="op reset" onClick={() => void run('RESET', () => unwrap(api.machine.reset()))} data-testid="btn-reset">
            <Icon name="reset" /> RESET
          </button>
          <button className="op homing" onClick={() => void run('HOMING', () => unwrap(api.machine.home()))} data-testid="btn-homing">
            <Icon name="homing" /> HOMING
          </button>
          <button className="op neutral" onClick={() => void report()} disabled={busy} data-testid="btn-report">
            <Icon name="report" /> REPORT
          </button>
          <button className="op neutral" onClick={() => setAdmin(true)} data-testid="btn-settings">
            <Icon name="settings" /> SETTINGS
          </button>
          <button className="op quiet" onClick={onLogout} data-testid="btn-logout">
            <Icon name="logout" /> LOGOUT
          </button>
          <button className="op quiet" onClick={onClose} data-testid="btn-close">
            <Icon name="close" /> CLOSE
          </button>
        </div>
      </div>
      {admin && (
        <AdminDialog
          onUnlocked={() => {
            setAdmin(false)
            onSettings()
          }}
          onClose={() => setAdmin(false)}
        />
      )}
    </div>
  )
}
