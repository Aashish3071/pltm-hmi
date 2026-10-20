import type { SpeedSettings } from '@shared/types'
import { useMachineStore } from '../../state/machineStore'

interface Props {
  maxHeightMm: number
  speeds: SpeedSettings
}

export default function ReadingsPanel({ maxHeightMm, speeds }: Props): JSX.Element {
  const loadN = useMachineStore((s) => s.loadN)
  const heightMm = useMachineStore((s) => s.heightMm)

  return (
    <div className="panel green">
      <div className="field-row">
        <label>Max Height(mm)</label>
        <div className="readonly-value">{maxHeightMm.toFixed(1)}</div>
      </div>
      <div className="field-row">
        <label>Load Value(N)</label>
        <div className="readonly-value">{loadN.toFixed(2)}</div>
      </div>
      <div className="field-row">
        <label>Panto Position(mm)</label>
        <div className="readonly-value">{heightMm.toFixed(2)}</div>
      </div>
      <div className="field-row">
        <label>Up Speed(mm/s)</label>
        <div className="readonly-value">{speeds.up.toFixed(1)}</div>
      </div>
      <div className="field-row">
        <label>Down Speed(mm/s)</label>
        <div className="readonly-value">{speeds.down.toFixed(1)}</div>
      </div>
      <div className="field-row">
        <label>Jog Speed(mm/s)</label>
        <div className="readonly-value">{speeds.jog.toFixed(1)}</div>
      </div>
    </div>
  )
}
