import { create } from 'zustand'

export type ToastKind = 'error' | 'success' | 'info'

export interface ToastAction {
  label: string
  run: () => void
}

interface Toast {
  id: number
  kind: ToastKind
  message: string
  action?: ToastAction
}

interface ToastState {
  toasts: Toast[]
  push: (kind: ToastKind, message: string, action?: ToastAction) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, action) => {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts.slice(-2), { id, kind, message, action }] }))
    const ttl = action ? 8000 : kind === 'error' ? 6000 : 4000
    setTimeout(() => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })), ttl)
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
}))

export const toast = {
  error: (message: string) => useToastStore.getState().push('error', message),
  success: (message: string, action?: ToastAction) =>
    useToastStore.getState().push('success', message, action),
  info: (message: string) => useToastStore.getState().push('info', message)
}
