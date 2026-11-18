import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import type { MessageInfo } from '@shared/types'

/** Modal message with one OK button. */
interface MessageState {
  queue: (MessageInfo & { resolve: () => void })[]
  push: (info: MessageInfo & { resolve: () => void }) => void
  pop: () => void
}

const useMessages = create<MessageState>((set) => ({
  queue: [],
  push: (info) => set((s) => ({ queue: [...s.queue, info] })),
  pop: () => set((s) => ({ queue: s.queue.slice(1) }))
}))

export function showMessage(info: MessageInfo): Promise<void> {
  return new Promise((resolve) => useMessages.getState().push({ ...info, resolve }))
}

export function critical(title: string, text: string): Promise<void> {
  return showMessage({ icon: 'critical', title, text })
}

export function information(title: string, text: string): Promise<void> {
  return showMessage({ icon: 'information', title, text })
}

export function MessageBoxHost(): JSX.Element | null {
  const current = useMessages((s) => s.queue[0])
  const pop = useMessages((s) => s.pop)
  const okRef = useRef<HTMLButtonElement>(null)
  useEffect(() => okRef.current?.focus(), [current])
  if (!current) return null
  const close = (): void => {
    pop()
    current.resolve()
  }
  return (
    <div className="modal-backdrop" onKeyDown={(e) => (e.key === 'Escape' || e.key === 'Enter') && close()}>
      <div className="dialog msgbox" role="dialog" aria-label={current.title} data-testid="msgbox">
        <div className="dialog-head">{current.title}</div>
        <div className="msgbox-body">
          <div className={`msgbox-icon ${current.icon}`}>
            {current.icon === 'critical' ? '!' : current.icon === 'warning' ? '!' : 'i'}
          </div>
          <div className="msgbox-text" data-testid="msgbox-text">
            {current.text}
          </div>
        </div>
        <div className="msgbox-buttons">
          <button ref={okRef} className="btn" style={{ minWidth: 96 }} onClick={close} data-testid="msgbox-ok">
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
