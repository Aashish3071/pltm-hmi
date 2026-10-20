import { useMachineStore } from '../../state/machineStore'

export default function CycleTimePanel(): JSX.Element {
  const upCycleSec = useMachineStore((s) => s.upCycleSec)
  const downCycleSec = useMachineStore((s) => s.downCycleSec)

  return (
    <div className="cycle-panel">
      <div className="cycle-item">
        <span className="arrow up">&#8593;</span>
        <div className="cycle-display">{upCycleSec.toFixed(1)}</div>
        <span className="unit">Sec</span>
      </div>
      <div className="cycle-item">
        <span className="arrow down">&#8595;</span>
        <div className="cycle-display">{downCycleSec.toFixed(1)}</div>
        <span className="unit">Sec</span>
      </div>
    </div>
  )
}
