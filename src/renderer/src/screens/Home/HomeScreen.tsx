import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  HardwareStatus,
  type MachineMode,
  type ModelConfig,
  type SpeedSettings,
  type UserAccount
} from '@shared/types'
import { api } from '../../api/client'
import { isRunning, useMachineStore } from '../../state/machineStore'
import { useSessionStore } from '../../state/sessionStore'
import { toast } from '../../state/toastStore'
import GraphPanel, { loadAxisMax, renderGraphPng } from './GraphPanel'
import StatusBar from './StatusBar'
import CycleTimePanel from './CycleTimePanel'
import ReadingsPanel from './ReadingsPanel'
import ModelSelectPanel from './ModelSelectPanel'
import OperatingButtons from './OperatingButtons'
import ManualJogControls from './ManualJogControls'
import SafetyStrip from './SafetyStrip'

interface Props {
  user: UserAccount
  onOpenSettings: () => void
  onLogout: () => void
}

type Result = { ok: boolean; message?: string }

export default function HomeScreen({ user, onOpenSettings, onLogout }: Props): JSX.Element {
  const [users, setUsers] = useState<UserAccount[]>([])
  const [models, setModels] = useState<ModelConfig[]>([])
  const [speeds, setSpeeds] = useState<SpeedSettings>({ up: 50, down: 50, jog: 50 })
  const [busy, setBusy] = useState(false)

  const selection = useSessionStore((s) => s.selection)
  const confirmed = useSessionStore((s) => s.confirmed)
  const setSelection = useSessionStore((s) => s.setSelection)
  const setConfirmed = useSessionStore((s) => s.setConfirmed)

  const status = useMachineStore((s) => s.status)
  const mode = useMachineStore((s) => s.mode)
  const connected = useMachineStore((s) => s.connected)
  const activeModelId = useMachineStore((s) => s.activeModelId)
  const clearGraph = useMachineStore((s) => s.clearGraph)

  useEffect(() => {
    void (async () => {
      const [userList, modelList, settings] = await Promise.all([
        api.users.list(),
        api.models.list(),
        api.settings.getAll()
      ])
      if (userList.ok) setUsers(userList.data)
      if (modelList.ok) setModels(modelList.data)
      if (settings.ok) {
        setSpeeds({
          up: Number(settings.data.up_speed_mm_s),
          down: Number(settings.data.down_speed_mm_s),
          jog: Number(settings.data.jog_speed_mm_s)
        })
      }
    })()
  }, [])

  // Keep the selection valid: default to the first model, drop deleted ones,
  // and follow the machine when a run is in progress or paused.
  useEffect(() => {
    if (models.length === 0) return
    const current = useSessionStore.getState().selection
    const valid = models.some((m) => m.id === current.modelId)
    if (activeModelId && models.some((m) => m.id === activeModelId)) {
      if (current.modelId !== activeModelId) setSelection({ ...current, modelId: activeModelId })
    } else if (!valid) {
      setSelection({ ...current, modelId: models[0].id })
      setConfirmed(false)
    }
    if (!current.employeeUserId) setSelection({ ...useSessionStore.getState().selection, employeeUserId: user.id })
  }, [models, activeModelId, user.id, setSelection, setConfirmed])

  const selectedModel = useMemo(
    () => models.find((m) => m.id === selection.modelId),
    [models, selection.modelId]
  )

  const envelope = useMemo(
    () =>
      selectedModel
        ? [...selectedModel.points]
            .sort((a, b) => a.rowIndex - b.rowIndex)
            .map((p) => ({ loadN: p.loadN, heightMm: p.heightMm }))
        : [],
    [selectedModel]
  )

  const maxHeightMm = selectedModel?.distanceMm ?? 4000
  const maxLoadN = loadAxisMax(envelope)

  /** Runs a machine command, showing its error; guards against double-taps. */
  const run = useCallback(
    async (action: () => Promise<Result>, successMessage?: string): Promise<boolean> => {
      setBusy(true)
      try {
        const result = await action()
        if (!result.ok) {
          toast.error(result.message ?? 'Command failed')
          return false
        }
        if (successMessage) toast.success(successMessage)
        return true
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const handleConfirm = (): void => {
    if (!selectedModel) {
      toast.error('Select a model.')
      return
    }
    if (!selection.partNo.trim()) {
      toast.error('Enter the Part-No before pressing OK.')
      return
    }
    setConfirmed(true)
  }

  const handleStart = async (): Promise<void> => {
    if (!confirmed) {
      toast.error('Select a model, enter the Part-No and press OK before starting a test.')
      return
    }
    await run(() => api.machine.start(selection))
  }

  /** STOP pauses; on a paused test the same button resumes from the same point. */
  const handleStopOrResume = async (): Promise<void> => {
    if (status === HardwareStatus.HALT) await run(() => api.machine.start(selection))
    else await run(() => api.machine.stop())
  }

  const handleReset = async (): Promise<void> => {
    const done = await run(() => api.machine.reset())
    if (done) clearGraph()
  }

  const handleModeChange = async (next: MachineMode): Promise<void> => {
    if (next === mode) return
    await run(() => api.machine.setMode(next), `${next} MODE enabled`)
  }

  const handleReport = async (): Promise<void> => {
    setBusy(true)
    try {
      // Draw the saved run, not whatever is on screen (it may have been RESET).
      const data = await api.reports.runPoints()
      if (!data.ok) {
        toast.error(data.message)
        return
      }
      const png = renderGraphPng({
        points: data.data.points,
        envelope: data.data.envelope,
        maxHeightMm: data.data.maxHeightMm,
        maxLoadN: loadAxisMax(data.data.envelope)
      })
      const result = await api.reports.generate(png)
      if (result.ok) {
        toast.success(`Report and certificate ${result.data.certificateNo} saved.`, {
          label: 'OPEN FOLDER',
          run: () => void api.reports.openFolder()
        })
      } else {
        toast.error(result.message)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleClear = (): void => {
    setConfirmed(false)
    setSelection({ employeeUserId: user.id, modelId: models[0]?.id ?? 0, partNo: '' })
  }

  const running = isRunning(status)
  const halted = status === HardwareStatus.HALT
  const canStart = connected && !running && !halted && !busy && mode === 'AUTO' && confirmed

  return (
    <div className="home">
      <GraphPanel envelope={envelope} maxHeightMm={maxHeightMm} maxLoadN={maxLoadN} />

      <div className="home-right">
        <div className="status-row">
          <StatusBar onModeChange={handleModeChange} />
          <CycleTimePanel />
        </div>

        <SafetyStrip />

        <div className="status-row">
          <ReadingsPanel maxHeightMm={maxHeightMm} speeds={speeds} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <ModelSelectPanel
              users={users}
              models={models}
              draft={selection}
              confirmed={confirmed}
              disabled={running || halted}
              onChange={setSelection}
              onConfirm={handleConfirm}
              onClear={handleClear}
            />
            {mode === 'MANUAL' && <ManualJogControls />}
          </div>
        </div>

        <OperatingButtons
          canStart={canStart}
          paused={halted}
          canStop={connected && (running || halted) && !busy}
          canReset={connected && !busy}
          canHome={connected && !running && !halted && !busy}
          canReport={!running && !busy}
          onStart={handleStart}
          onStop={handleStopOrResume}
          onReset={handleReset}
          onHoming={() => void run(() => api.machine.home(), 'Home position set.')}
          onReport={handleReport}
          onSettings={onOpenSettings}
          onLogout={onLogout}
          onClose={() => void api.app.quit()}
        />
      </div>
    </div>
  )
}
