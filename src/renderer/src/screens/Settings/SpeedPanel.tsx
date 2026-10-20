import { useEffect, useState } from 'react'
import { MAX_SPEED_MM_S, type SpeedSettings } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'

interface Props {
  speeds: SpeedSettings
  onSpeedsChange: (speeds: SpeedSettings) => void
}

type Draft = Record<keyof SpeedSettings, string>

function toDraft(speeds: SpeedSettings): Draft {
  return { up: String(speeds.up), down: String(speeds.down), jog: String(speeds.jog) }
}

export default function SpeedPanel({ speeds, onSpeedsChange }: Props): JSX.Element {
  const [draft, setDraft] = useState<Draft>(toDraft(speeds))

  useEffect(() => setDraft(toDraft(speeds)), [speeds])

  const edit = (key: keyof SpeedSettings, value: string): void => {
    if (/^\d*\.?\d*$/.test(value)) setDraft({ ...draft, [key]: value })
  }

  const upload = async (): Promise<void> => {
    const result = await api.settings.setSpeeds({
      up: Number(draft.up),
      down: Number(draft.down),
      jog: Number(draft.jog)
    })
    if (result.ok) {
      onSpeedsChange(result.data)
      toast.success('Speeds uploaded to the machine.')
    } else {
      toast.error(result.message)
    }
  }

  const rows: [keyof SpeedSettings, string][] = [
    ['up', 'UP SPEED'],
    ['down', 'DOWN SPEED'],
    ['jog', 'JOG SPEED']
  ]

  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#9881;</span> SPEED (mm/s)
      </div>
      {rows.map(([key, label]) => (
        <div className="field-row" key={key}>
          <label>{label}</label>
          <input inputMode="decimal" value={draft[key]} onChange={(e) => edit(key, e.target.value)} />
        </div>
      ))}
      <div className="hint">Allowed range: above 0 up to {MAX_SPEED_MM_S} mm/s.</div>
      <button className="btn yellow small" style={{ marginTop: 8 }} onClick={upload}>
        UPLOAD
      </button>
    </div>
  )
}
