import { useEffect, useMemo, useState } from 'react'
import type { ModelPoint, UserAccount } from '@shared/types'
import { sortedPoints } from '@shared/analysis'
import { api, unwrap } from '../api/client'
import { Header } from '../components/Header'
import { Icon } from '../components/Icons'
import { critical, information } from '../components/MessageBox'
import { PlotView } from '../components/Plot'
import { currentModel, refreshModelsAndSelection, useMachine } from '../state/machine'
import SystemDialog from './SystemDialog'
import DataDialog from './DataDialog'

export default function SettingsScreen({
  onHome,
  onLogout,
  onClose
}: {
  onHome: () => void
  onLogout: () => void
  onClose: () => void
}): JSX.Element {
  const models = useMachine((s) => s.models)
  const selection = useMachine((s) => s.selection)
  const [modelName, setModelName] = useState('')
  const [distance, setDistance] = useState('')
  const [loads, setLoads] = useState<string[]>(Array(9).fill(''))
  const [heights, setHeights] = useState<string[]>(Array(9).fill(''))
  const [users, setUsers] = useState<UserAccount[]>([])
  const [userId, setUserId] = useState(0)
  const [password, setPassword] = useState('')
  const [names, setNames] = useState<string[]>(['', '', '', ''])
  const [speeds, setSpeeds] = useState({ up: '', down: '', jog: '' })
  const [system, setSystem] = useState(false)
  const [data, setData] = useState(false)

  const model = useMemo(() => currentModel(), [models, selection])

  const loadModel = (): void => {
    const m = currentModel()
    if (!m) return
    const pts = sortedPoints(m)
    setModelName(m.name)
    setLoads(Array.from({ length: 9 }, (_, i) => (pts[i] ? trim(pts[i].loadN) : '')))
    setHeights(Array.from({ length: 9 }, (_, i) => (pts[i] ? trim(pts[i].heightMm) : '')))
  }

  useEffect(() => {
    void (async () => {
      await refreshModelsAndSelection()
      loadModel()
      const [settings, list] = await Promise.all([unwrap(api.settings.get()), unwrap(api.users.list())])
      setDistance(trim(settings.distanceMm))
      setSpeeds({ up: trim(settings.speeds.up), down: trim(settings.speeds.down), jog: trim(settings.speeds.jog) })
      setUsers(list)
      setNames(list.map((u) => u.displayName))
      setUserId(list[0]?.id ?? 0)
    })()
  }, [])

  const fail = (title: string, error: unknown): Promise<void> => critical(title, (error as Error).message)

  const saveModel = async (): Promise<void> => {
    if (!modelName.trim()) {
      await critical('Model', 'Model name cannot be empty.')
      return
    }
    const points: ModelPoint[] = loads.map((l, i) => ({ rowIndex: i + 1, loadN: Number(l), heightMm: Number(heights[i]) }))
    try {
      const saved = await unwrap(api.models.save({ id: model?.id, name: modelName.trim(), points }))
      await refreshModelsAndSelection()
      loadModel()
      setDistance(trim(saved.current.distanceMm))
      await unwrap(api.settings.upload(toSpeeds(speeds), saved.current.distanceMm))
      await information('Model', `Model "${saved.current.name}" saved.`)
    } catch (error) {
      await fail('Model', error)
    }
  }

  const upload = async (): Promise<void> => {
    try {
      await unwrap(api.settings.upload(toSpeeds(speeds), Number(distance)))
      await refreshModelsAndSelection()
      await information('Speeds', 'Values uploaded to the machine.')
    } catch (error) {
      await fail('Speeds', error)
    }
  }

  const changePassword = async (): Promise<void> => {
    try {
      await unwrap(api.users.changePassword(userId, password))
      setPassword('')
      await information('Password', 'Password changed.')
    } catch (error) {
      await fail('Password', error)
    }
  }

  const saveNames = async (): Promise<void> => {
    try {
      const list = await unwrap(api.users.saveNames(names))
      setUsers(list)
      setNames(list.map((u) => u.displayName))
      await information('Users', 'User names saved.')
    } catch (error) {
      await fail('Users', error)
    }
  }

  const preview = useMemo(
    () => ({ points: loads.map((l, i) => ({ rowIndex: i + 1, loadN: Number(l) || 0, heightMm: Number(heights[i]) || 0 })) }),
    [loads, heights]
  )

  return (
    <div className="screen">
      <Header title="Settings">
        <button className="header-btn" onClick={() => setData(true)} data-testid="s-data">
          <Icon name="report" size={16} /> DATA
        </button>
        <button className="header-btn" onClick={() => setSystem(true)} data-testid="s-system">
          <Icon name="plug" size={16} /> SYSTEM
        </button>
      </Header>
      <div className="body" style={{ gridTemplateColumns: '760px 1fr', gridTemplateRows: 'auto auto 1fr auto' }}>
        <div className="card" style={{ gridRow: '1 / span 4', flexDirection: 'row', gap: 16 }}>
          <div style={{ width: 300, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="card-title">
              <Icon name="settings" size={16} /> Pantograph model
            </div>
            <div className="form" style={{ gridTemplateColumns: '84px 1fr' }}>
              <label>Model</label>
              <input className="input" value={modelName} onChange={(e) => setModelName(e.target.value)} data-testid="s-model" />
              <label>Distance</label>
              <input
                className="input num"
                value={distance}
                inputMode="decimal"
                onChange={(e) => setDistance(e.target.value)}
                data-testid="s-distance"
              />
            </div>
            <div className="points">
              <span />
              <span className="head">Load (N)</span>
              <span className="head">Height (mm)</span>
              {loads.map((l, i) => (
                <Row
                  key={i}
                  i={i}
                  load={l}
                  height={heights[i]}
                  onLoad={(v) => setLoads(loads.map((x, j) => (j === i ? v : x)))}
                  onHeight={(v) => setHeights(heights.map((x, j) => (j === i ? v : x)))}
                />
              ))}
            </div>
            <div className="note">Point 4's height is the distance the pantograph travels.</div>
            <div className="row" style={{ marginTop: 'auto' }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => void saveModel()} data-testid="s-ok">
                OK
              </button>
              <button
                className="btn ghost"
                style={{ flex: 1 }}
                onClick={() => {
                  setLoads(Array(9).fill(''))
                  setHeights(Array(9).fill(''))
                }}
                data-testid="s-clear"
              >
                CLEAR
              </button>
            </div>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div className="card-title">Reference preview</div>
            <PlotView data={{ model: preview, n: null, n1: null, n2: null, referenceOnly: true }} />
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <Icon name="lock" size={16} /> Change password
          </div>
          <div className="form">
            <label>User name</label>
            <select
              className="input"
              value={userId}
              onChange={(e) => {
                setUserId(Number(e.target.value))
                setPassword('')
              }}
              data-testid="s-user"
            >
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
            <label>Password</label>
            <div className="row">
              <input
                className="input"
                type="password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="s-password"
              />
              <button className="btn" onClick={() => void changePassword()} data-testid="s-change">
                CHANGE
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <Icon name="user" size={16} /> Users
          </div>
          <div className="form" style={{ gridTemplateColumns: '24px 1fr 24px 1fr' }}>
            {names.map((name, i) => (
              <Name key={i} i={i} value={name} onChange={(v) => setNames(names.map((x, j) => (j === i ? v : x)))} />
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn" onClick={() => void saveNames()} data-testid="s-savenames">
              SAVE
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <Icon name="gauge" size={16} /> Speeds (mm/s)
          </div>
          <div className="form" style={{ gridTemplateColumns: '1fr 110px' }}>
            <label>Up speed</label>
            <input className="input num" value={speeds.up} onChange={(e) => setSpeeds({ ...speeds, up: e.target.value })} data-testid="s-upspeed" />
            <label>Down speed</label>
            <input
              className="input num"
              value={speeds.down}
              onChange={(e) => setSpeeds({ ...speeds, down: e.target.value })}
              data-testid="s-downspeed"
            />
            <label>Jog speed</label>
            <input className="input num" value={speeds.jog} onChange={(e) => setSpeeds({ ...speeds, jog: e.target.value })} data-testid="s-jogspeed" />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button className="btn" onClick={() => void upload()} data-testid="s-upload">
              UPLOAD
            </button>
          </div>
        </div>

        <div className="ops" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <button className="op neutral" onClick={onHome} data-testid="s-home">
            <Icon name="homing" /> HOME
          </button>
          <button className="op quiet" onClick={onLogout} data-testid="s-logout">
            <Icon name="logout" /> LOGOUT
          </button>
          <button className="op quiet" onClick={onClose} data-testid="s-closeapp">
            <Icon name="close" /> CLOSE
          </button>
        </div>
      </div>
      {system && <SystemDialog onClose={() => setSystem(false)} />}
      {data && <DataDialog onClose={() => setData(false)} />}
    </div>
  )
}

function Row(props: { i: number; load: string; height: string; onLoad: (v: string) => void; onHeight: (v: string) => void }): JSX.Element {
  const { i } = props
  return (
    <>
      <span className={`idx ${i === 3 ? 'travel' : ''}`}>{i + 1}</span>
      <input className="input num" value={props.load} inputMode="decimal" onChange={(e) => props.onLoad(e.target.value)} data-testid={`s-load${i + 1}`} />
      <input className="input num" value={props.height} inputMode="decimal" onChange={(e) => props.onHeight(e.target.value)} data-testid={`s-height${i + 1}`} />
    </>
  )
}

function Name({ i, value, onChange }: { i: number; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <>
      <label style={{ color: 'var(--muted)' }}>{i + 1}.</label>
      <input className="input" value={value} onChange={(e) => onChange(e.target.value)} data-testid={`s-name${i + 1}`} />
    </>
  )
}

function toSpeeds(s: { up: string; down: string; jog: string }): { up: number; down: number; jog: number } {
  return { up: Number(s.up), down: Number(s.down), jog: Number(s.jog) }
}

function trim(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
}
