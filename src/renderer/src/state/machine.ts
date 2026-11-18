import { create } from 'zustand'
import type { GraphHistory, MachineEvent, ModelConfig, PlcState, Sample, Selection, UserAccount } from '@shared/types'
import { api, unwrap } from '../api/client'

const EMPTY_STATE: PlcState = {
  connected: false,
  timestampMs: 0,
  loadN: 0,
  positionMm: 0,
  code: 100,
  upTimeSec: 0,
  downTimeSec: 0,
  mode: null
}

interface MachineStore {
  state: PlcState
  /** The current test (n) and the two before it, as the graph shows them. */
  n: Sample[]
  n1: Sample[]
  n2: Sample[]
  historyVersion: number
  /** Bumped on every recorded sample so the graph redraws. */
  tick: number
  user: UserAccount | null
  selection: Selection | null
  models: ModelConfig[]
  setUser: (user: UserAccount | null) => void
  setSelection: (selection: Selection) => void
  setModels: (models: ModelConfig[]) => void
}

export const useMachine = create<MachineStore>((set) => ({
  state: EMPTY_STATE,
  n: [],
  n1: [],
  n2: [],
  historyVersion: 0,
  tick: 0,
  user: null,
  selection: null,
  models: [],
  setUser: (user) => set({ user }),
  setSelection: (selection) => set({ selection }),
  setModels: (models) => set({ models })
}))

let loadingHistory = false

async function loadHistory(): Promise<void> {
  if (loadingHistory) return
  loadingHistory = true
  try {
    const h: GraphHistory = await unwrap(api.machine.history())
    useMachine.setState({ n: [...h.n], n1: h.n1, n2: h.n2, historyVersion: h.version, tick: Date.now() })
  } catch {
    // retried on the next event
  } finally {
    loadingHistory = false
  }
}

function onEvent(event: MachineEvent): void {
  const s = useMachine.getState()
  if (event.historyVersion !== s.historyVersion) {
    useMachine.setState({ state: event.state })
    void loadHistory()
    return
  }
  if (event.recorded) {
    const st = event.state
    s.n.push({ loadN: st.loadN, positionMm: st.positionMm, code: st.code })
    useMachine.setState({ state: st, tick: s.tick + 1 })
  } else {
    useMachine.setState({ state: event.state })
  }
}

/** Subscribes to the main process. Returns an unsubscribe. */
export function connectMachine(): () => void {
  const off = api.machine.onEvent(onEvent)
  void api.machine.state().then((r) => r.ok && useMachine.setState({ state: r.data }))
  void loadHistory()
  return off
}

export async function refreshModelsAndSelection(): Promise<void> {
  const [models, selection] = await Promise.all([unwrap(api.models.list()), unwrap(api.machine.selection())])
  useMachine.setState({ models, selection })
}

export function currentModel(): ModelConfig | null {
  const { models, selection } = useMachine.getState()
  return models.find((m) => m.id === selection?.modelId) ?? null
}
