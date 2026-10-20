interface Props {
  canStart: boolean
  /** STOP becomes RESUME while a test is paused, as in the original HMI. */
  paused: boolean
  canStop: boolean
  canReset: boolean
  canHome: boolean
  canReport: boolean
  onStart: () => void
  onStop: () => void
  onReset: () => void
  onHoming: () => void
  onReport: () => void
  onSettings: () => void
  onLogout: () => void
  onClose: () => void
}

export default function OperatingButtons(props: Props): JSX.Element {
  return (
    <div className="operating-buttons">
      <button className="op-btn start" onClick={props.onStart} disabled={!props.canStart}>
        <span className="icon">&#9211;</span> START
      </button>
      <button className="op-btn stop" onClick={props.onStop} disabled={!props.canStop}>
        <span className="icon">&#9210;</span> {props.paused ? 'RESUME' : 'STOP'}
      </button>
      <button className="op-btn reset" onClick={props.onReset} disabled={!props.canReset}>
        <span className="icon">&#8635;</span> RESET
      </button>
      <button className="op-btn homing" onClick={props.onHoming} disabled={!props.canHome}>
        <span className="icon">&#9678;</span> HOMING
      </button>
      <button className="op-btn" onClick={props.onReport} disabled={!props.canReport}>
        <span className="icon">&#128190;</span> REPORT
      </button>
      <button className="op-btn" onClick={props.onSettings}>
        <span className="icon">&#9881;</span> SETTINGS
      </button>
      <button className="op-btn" onClick={props.onLogout}>
        <span className="icon">&#8612;</span> LOGOUT
      </button>
      <button className="op-btn close" onClick={props.onClose}>
        <span className="icon">&#10006;</span> CLOSE
      </button>
    </div>
  )
}
