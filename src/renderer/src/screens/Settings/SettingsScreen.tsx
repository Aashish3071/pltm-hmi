import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  HardwareDriver,
  MachineSettings,
  ModelConfig,
  ModelPoint,
  SpeedSettings,
  UserAccount
} from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'
import GraphPanel, { loadAxisMax } from '../Home/GraphPanel'
import AdminGate from './AdminGate'
import ConnectionPanel from './ConnectionPanel'
import MachinePanel from './MachinePanel'
import ModelConfigPanel, { NEW_MODEL_ID } from './ModelConfigPanel'
import UsersPanel from './UsersPanel'
import PasswordPanel from './PasswordPanel'
import SpeedPanel from './SpeedPanel'

interface Props {
  onHome: () => void
  onLogout: () => void
}

type Tab = 'users' | 'machine' | 'connection'

const NO_POINTS: { loadN: number; heightMm: number }[] = []

export default function SettingsScreen({ onHome, onLogout }: Props): JSX.Element {
  const [unlocked, setUnlocked] = useState(false)
  const [tab, setTab] = useState<Tab>('users')
  const [users, setUsers] = useState<UserAccount[]>([])
  const [models, setModels] = useState<ModelConfig[]>([])
  const [selectedId, setSelectedId] = useState(NEW_MODEL_ID)
  const [draft, setDraft] = useState<ModelPoint[]>([])
  const [speeds, setSpeeds] = useState<SpeedSettings | null>(null)
  const [machine, setMachine] = useState<MachineSettings | null>(null)
  const [driver, setDriver] = useState<HardwareDriver>('simulator')
  const [reportDir, setReportDir] = useState('')

  const loadAll = useCallback(async (): Promise<void> => {
    const [userList, modelList, settings, info] = await Promise.all([
      api.users.list(),
      api.models.list(),
      api.settings.getAll(),
      api.app.systemInfo()
    ])
    if (userList.ok) setUsers(userList.data)
    if (modelList.ok) {
      setModels(modelList.data)
      setSelectedId((prev) => (prev !== NEW_MODEL_ID ? prev : (modelList.data[0]?.id ?? NEW_MODEL_ID)))
    }
    if (settings.ok) {
      const s = settings.data
      setSpeeds({
        up: Number(s.up_speed_mm_s),
        down: Number(s.down_speed_mm_s),
        jog: Number(s.jog_speed_mm_s)
      })
      setMachine({
        machineId: s.machine_id ?? '',
        loadCapacityN: Number(s.load_capacity_n),
        heightCapacityMm: Number(s.height_capacity_mm)
      })
      setReportDir(s.resolved_report_dir ?? '')
    }
    if (info.ok) setDriver(info.data.driver)
  }, [])

  useEffect(() => {
    if (unlocked) void loadAll()
  }, [unlocked, loadAll])

  const envelope = useMemo(
    () =>
      draft.map((p) => ({ loadN: p.loadN, heightMm: p.heightMm })),
    [draft]
  )
  const distance = draft[3]?.heightMm || 0
  const graphHeight = Math.max(distance, ...draft.map((p) => p.heightMm), 1) * 1.05

  const pickReportDir = async (): Promise<void> => {
    const result = await api.settings.pickReportDir()
    if (result.ok) {
      setReportDir(result.data)
      toast.success('Report folder updated.')
    } else {
      toast.error(result.message)
    }
  }

  const simulateFault = async (kind: string): Promise<void> => {
    const result = await api.machine.forceFault(kind)
    if (!result.ok) toast.error(result.message)
  }

  if (!unlocked) return <AdminGate onPass={() => setUnlocked(true)} onCancel={onHome} />

  return (
    <div className="settings">
      <div className="settings-col">
        <GraphPanel
          envelope={envelope}
          points={NO_POINTS}
          maxHeightMm={graphHeight}
          maxLoadN={loadAxisMax(envelope)}
        />
      </div>

      <div className="settings-col">
        <ModelConfigPanel
          models={models}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onModelsChange={setModels}
          onDraftChange={setDraft}
        />
      </div>

      <div className="settings-col">
        <div className="tabs">
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            USERS &amp; SPEED
          </button>
          <button className={tab === 'machine' ? 'active' : ''} onClick={() => setTab('machine')}>
            MACHINE
          </button>
          <button
            className={tab === 'connection' ? 'active' : ''}
            onClick={() => setTab('connection')}
          >
            CONNECTION
          </button>
        </div>

        <div className="tab-body">
          {tab === 'users' && (
            <>
              <PasswordPanel users={users} />
              <UsersPanel users={users} onUsersChange={setUsers} />
              {speeds && <SpeedPanel speeds={speeds} onSpeedsChange={setSpeeds} />}
            </>
          )}

          {tab === 'machine' && (
            <>
              {machine && <MachinePanel settings={machine} onChange={setMachine} />}
              <div className="panel orange">
                <div className="section-title">
                  <span className="glyph">&#128193;</span> REPORT FOLDER
                </div>
                <div style={{ fontSize: 11, wordBreak: 'break-all', marginBottom: 8 }}>
                  {reportDir}
                </div>
                <button className="btn small" onClick={pickReportDir}>
                  CHANGE FOLDER
                </button>
              </div>
              {driver === 'simulator' && (
                <div className="panel orange">
                  <div className="section-title">
                    <span className="glyph">&#9888;</span> SIMULATE FAULT
                  </div>
                  <div className="dev-tools">
                    {(['EMERGENCY', 'SERVO_ERROR', 'SERVO_OFF', 'OVERLOAD', 'DISCONNECT'] as const).map(
                      (kind) => (
                        <button key={kind} className="btn small" onClick={() => void simulateFault(kind)}>
                          {kind.replace('_', ' ')}
                        </button>
                      )
                    )}
                  </div>
                  <div className="hint">
                    Simulator only. Stands in for machine faults; DISCONNECT recovers after 5 s.
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'connection' && <ConnectionPanel onApplied={() => void loadAll()} />}
        </div>

        <div className="settings-footer">
          <button className="btn yellow" onClick={onHome}>
            HOME
          </button>
          <button className="btn" onClick={onLogout}>
            LOGOUT
          </button>
          <button className="btn red" onClick={() => void api.app.quit()}>
            CLOSE
          </button>
        </div>
      </div>
    </div>
  )
}
