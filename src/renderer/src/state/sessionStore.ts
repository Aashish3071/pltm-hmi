import { create } from 'zustand'
import type { UserAccount } from '@shared/types'

export interface Selection {
  employeeUserId: number
  modelId: number
  partNo: string
}

interface SessionState {
  user: UserAccount | null
  selection: Selection
  /** OK pressed: selection is locked in for the next START. */
  confirmed: boolean
  setUser: (user: UserAccount | null) => void
  setSelection: (selection: Selection) => void
  setConfirmed: (confirmed: boolean) => void
}

const empty: Selection = { employeeUserId: 0, modelId: 0, partNo: '' }

/** Lives outside the screens so navigating to Settings and back keeps the selection. */
export const useSessionStore = create<SessionState>((set) => ({
  user: null,
  selection: empty,
  confirmed: false,
  setUser: (user) =>
    set({
      user,
      selection: { ...empty, employeeUserId: user?.id ?? 0 },
      confirmed: false
    }),
  setSelection: (selection) => set({ selection }),
  setConfirmed: (confirmed) => set({ confirmed })
}))
