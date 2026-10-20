import { useEffect, useState } from 'react'
import type { MachineMode } from '@shared/types'
import { isFault, useMachineStore } from '../../state/machineStore'

interface Props {
  onModeChange: (mode: MachineMode) => void
}

export default function StatusBar({ onModeChange }: Props): JSX.Element {
  const status = useMachineStore((s) => s.status)
  const mode = useMachineStore((s) => s.mode)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const alarm = isFault(status)
  const clock = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  })

  return (
    <div className="status-bar">
      <div className="status-top">
        <span className="status-text">{status}</span>
        <span className={`bell ${alarm ? 'alarm' : ''}`}>{alarm ? '\u{1F514}' : '\u{1F515}'}</span>
      </div>
      <div className="status-bottom">
        <div>
          <button
            className={`mode-pill ${mode === 'AUTO' ? 'active' : ''}`}
            onClick={() => onModeChange('AUTO')}
          >
            AUTO MODE
          </button>
          <button
            className={`mode-pill ${mode === 'MANUAL' ? 'active' : ''}`}
            onClick={() => onModeChange('MANUAL')}
          >
            MANUAL MODE
          </button>
        </div>
        <span className="clock">
          {clock} {date}
        </span>
      </div>
    </div>
  )
}
