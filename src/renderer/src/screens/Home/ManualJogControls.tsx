import { useEffect, useRef, useState } from 'react'
import type { JogDirection } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'

/** Must stay well inside the main process's jog watchdog window. */
const KEEPALIVE_MS = 200

/**
 * Software stand-in for the physical UP/DOWN pendant while in MANUAL mode.
 * Hold-to-run: the button re-confirms every 200 ms; if confirmations stop
 * (touch lost, window blurred, app hung) the machine stops on its own.
 */
export default function ManualJogControls(): JSX.Element {
  const [held, setHeld] = useState<JogDirection | null>(null)
  const timer = useRef<number | null>(null)
  /** What the operator's finger is doing right now — the source of truth. */
  const wanted = useRef<JogDirection | null>(null)

  const release = (): void => {
    const direction = wanted.current
    wanted.current = null
    if (timer.current !== null) window.clearInterval(timer.current)
    timer.current = null
    setHeld(null)
    if (direction) void api.machine.jog(direction, false)
  }

  const press = async (direction: JogDirection): Promise<void> => {
    release()
    wanted.current = direction
    const result = await api.machine.jog(direction, true)
    if (wanted.current !== direction) {
      // Released while the command was in flight.
      void api.machine.jog(direction, false)
      return
    }
    if (!result.ok) {
      wanted.current = null
      toast.error(result.message)
      return
    }
    setHeld(direction)
    timer.current = window.setInterval(() => {
      void api.machine.jog(direction, true)
    }, KEEPALIVE_MS)
  }

  useEffect(() => {
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('blur', release)
      release()
    }
  }, [])

  const handlers = (direction: JogDirection) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      void press(direction)
    },
    onPointerUp: release,
    onPointerCancel: release,
    onLostPointerCapture: release,
    onContextMenu: (event: React.MouseEvent) => event.preventDefault()
  })

  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#127918;</span> MANUAL JOG
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className={`btn jog-btn ${held === 'UP' ? 'held' : ''}`} {...handlers('UP')}>
          &#8593; UP
        </button>
        <button className={`btn jog-btn ${held === 'DOWN' ? 'held' : ''}`} {...handlers('DOWN')}>
          &#8595; DOWN
        </button>
      </div>
      <div className="hint">Hold to jog. Switch back to AUTO MODE to run a test.</div>
    </div>
  )
}
