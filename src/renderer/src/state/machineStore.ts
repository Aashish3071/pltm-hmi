import { create } from 'zustand'
import {
  FAULT_STATUSES,
  HardwareStatus,
  type CycleCompleteEvent,
  type HardwareSnapshot,
  type MachineMode,
  type RunPhase,
  type TelemetryFrame
} from '@shared/types'
import { api } from '../api/client'

const MAX_GRAPH_POINTS = 20000

interface GraphPoint {
  loadN: number
  heightMm: number
}

interface MachineState {
  connected: boolean
  status: HardwareStatus
  mode: MachineMode
  homed: boolean
  loadN: number
  heightMm: number
  phase: RunPhase
  upCycleSec: number
  downCycleSec: number
  points: GraphPoint[]
  /** Model of the run in progress (or paused), as reported by the machine. */
  activeModelId: number | null
  applySnapshot: (snapshot: HardwareSnapshot) => void
  applyTelemetry: (frame: TelemetryFrame) => void
  applyStatus: (status: HardwareStatus) => void
  applyConnection: (connected: boolean) => void
  applyCycle: (event: CycleCompleteEvent) => void
  clearGraph: () => void
}

export const useMachineStore = create<MachineState>((set) => ({
  connected: false,
  status: HardwareStatus.DISCONNECTED,
  mode: 'AUTO',
  homed: false,
  loadN: 0,
  heightMm: 0,
  phase: 'idle',
  upCycleSec: 0,
  downCycleSec: 0,
  points: [],
  activeModelId: null,

  applySnapshot: (snapshot) =>
    set({
      connected: snapshot.connected,
      status: snapshot.status,
      mode: snapshot.mode,
      homed: snapshot.homed,
      loadN: snapshot.loadN,
      heightMm: snapshot.heightMm,
      phase: snapshot.phase,
      upCycleSec: snapshot.upCycleSec,
      downCycleSec: snapshot.downCycleSec,
      activeModelId: snapshot.activeModelId
    }),

  applyTelemetry: (frame) =>
    set((state) => ({
      loadN: frame.loadN,
      heightMm: frame.heightMm,
      phase: frame.phase,
      mode: frame.mode,
      homed: frame.homed,
      upCycleSec: frame.upCycleSec,
      downCycleSec: frame.downCycleSec,
      points:
        frame.phase === 'idle' || state.points.length >= MAX_GRAPH_POINTS
          ? state.points
          : [...state.points, { loadN: frame.loadN, heightMm: frame.heightMm }]
    })),

  applyStatus: (status) => set({ status }),
  applyConnection: (connected) => set({ connected }),
  applyCycle: (event) =>
    set(event.phase === 'up' ? { upCycleSec: event.elapsedSec } : { downCycleSec: event.elapsedSec }),
  clearGraph: () => set({ points: [], upCycleSec: 0, downCycleSec: 0 })
}))

/** Refreshes everything the push events do not carry (homed, mode, active model). */
export async function refreshSnapshot(): Promise<void> {
  const result = await api.machine.snapshot()
  if (result.ok) useMachineStore.getState().applySnapshot(result.data)
}

/** Subscribes the store to main-process hardware events. Returns an unsubscribe. */
export function connectMachineEvents(): () => void {
  const store = useMachineStore.getState()
  const offs = [
    api.machine.onTelemetry(store.applyTelemetry),
    api.machine.onStatus((status) => {
      store.applyStatus(status)
      // Status changes can flip homed/mode/active model, which only the snapshot carries.
      void refreshSnapshot()
    }),
    api.machine.onConnection(({ connected }) => {
      store.applyConnection(connected)
      if (connected) void refreshSnapshot()
    }),
    api.machine.onCycleComplete(store.applyCycle)
  ]
  void refreshSnapshot()
  return () => offs.forEach((off) => off())
}

export function isFault(status: HardwareStatus): boolean {
  return FAULT_STATUSES.includes(status)
}

export function isRunning(status: HardwareStatus): boolean {
  return status === HardwareStatus.PANTO_RAISING || status === HardwareStatus.PANTO_RETRIEVING
}
