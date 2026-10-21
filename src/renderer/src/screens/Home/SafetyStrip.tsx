import { useEffect, useState } from 'react'
import type { CalibrationStatus } from '@shared/types'
import { api } from '../../api/client'
import { useMachineStore } from '../../state/machineStore'

type Tone = 'ok' | 'bad' | 'off'

function Chip({ label, value, tone }: { label: string; value: string; tone: Tone }): JSX.Element {
  return (
    <span className={`safety-chip ${tone}`} title={`${label}: ${value}`}>
      <b>{label}</b> {value}
    </span>
  )
}

const CALIBRATION_REFRESH_MS = 60_000

/**
 * The machine's safety functions as the PLC reports them, plus load-cell
 * calibration validity. Unmapped signals show as "not wired" so a missing
 * safety input is visible rather than silently assumed healthy.
 */
export default function SafetyStrip(): JSX.Element | null {
  const safety = useMachineStore((s) => s.safety)
  const connected = useMachineStore((s) => s.connected)
  const [calibration, setCalibration] = useState<CalibrationStatus | null>(null)

  useEffect(() => {
    const load = (): void => {
      void api.calibration.status().then((result) => {
        if (result.ok) setCalibration(result.data)
      })
    }
    load()
    const timer = window.setInterval(load, CALIBRATION_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [])

  if (!safety || !connected) return null

  const signal = (active: boolean | null, okText: string, badText: string): [string, Tone] =>
    active === null ? ['not wired', 'off'] : active ? [badText, 'bad'] : [okText, 'ok']

  const [estop, estopTone] = signal(safety.estop, 'OK', 'PRESSED')
  const [overload, overloadTone] = signal(safety.overloadTrip, 'OK', 'TRIPPED')
  const limitsMapped = safety.upperLimit !== null || safety.lowerLimit !== null
  const limitHit = safety.upperLimit ? 'UPPER HIT' : safety.lowerLimit ? 'LOWER HIT' : null
  const calNotice = calibrationNotice(calibration)

  return (
    <div className="safety-strip">
      <Chip label="E-STOP" value={estop} tone={estopTone} />
      <Chip label="OVERLOAD" value={overload} tone={overloadTone} />
      <Chip
        label="LIMITS"
        value={limitsMapped ? (limitHit ?? 'OK') : 'not wired'}
        tone={limitsMapped ? (limitHit ? 'bad' : 'ok') : 'off'}
      />
      <Chip
        label="WATCHDOG"
        value={safety.source === 'simulator' ? 'SIMULATOR' : safety.heartbeat ? 'ON' : 'OFF'}
        tone={safety.source === 'simulator' ? 'off' : safety.heartbeat ? 'ok' : 'bad'}
      />
      {calNotice && <span className={`calibration-notice ${calNotice.tone}`}>{calNotice.text}</span>}
    </div>
  )
}

function calibrationNotice(status: CalibrationStatus | null): { text: string; tone: Tone } | null {
  if (!status?.applies) return null
  const parts: string[] = []
  let tone: Tone = 'ok'
  const describe = (what: string, state: string, days: number | null): void => {
    if (state === 'missing') {
      parts.push(`${what} not recorded`)
      tone = 'bad'
    } else if (state === 'overdue') {
      parts.push(`${what} overdue`)
      tone = 'bad'
    } else if (state === 'due-soon') {
      parts.push(`${what} due in ${days} day${days === 1 ? '' : 's'}`)
      if (tone !== 'bad') tone = 'off'
    }
  }
  describe('Load-cell calibration', status.calibrationState, status.daysToCalibrationDue)
  describe('Load-cell certificate', status.certificateState, status.daysToCertificateDue)
  if (parts.length === 0) return null
  return { text: `${parts.join(' · ')}${status.blocking ? ' — testing blocked' : ''}`, tone }
}
