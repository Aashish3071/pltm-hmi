import type { ModelConfig, UserAccount } from '@shared/types'
import type { Selection } from '../../state/sessionStore'

export type { Selection }

interface Props {
  users: UserAccount[]
  models: ModelConfig[]
  draft: Selection
  confirmed: boolean
  disabled: boolean
  onChange: (draft: Selection) => void
  onConfirm: () => void
  onClear: () => void
}

export default function ModelSelectPanel({
  users,
  models,
  draft,
  confirmed,
  disabled,
  onChange,
  onConfirm,
  onClear
}: Props): JSX.Element {
  const locked = confirmed || disabled
  return (
    <div className={`panel model-panel ${confirmed ? 'confirmed' : ''}`}>
      <div className="field-row">
        <label>Employee</label>
        <select
          value={draft.employeeUserId}
          disabled={locked}
          onChange={(e) => onChange({ ...draft, employeeUserId: Number(e.target.value) })}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <label>Model</label>
        <select
          value={draft.modelId}
          disabled={locked}
          onChange={(e) => onChange({ ...draft, modelId: Number(e.target.value) })}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <label>Part-No</label>
        <input
          value={draft.partNo}
          placeholder="#####"
          maxLength={40}
          disabled={locked}
          onChange={(e) => onChange({ ...draft, partNo: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !locked) onConfirm()
          }}
        />
      </div>
      <div className="actions">
        <button className="btn green" onClick={onConfirm} disabled={locked}>
          OK
        </button>
        <button className="btn red" onClick={onClear} disabled={disabled}>
          CLEAR
        </button>
      </div>
      {confirmed && <div className="hint">Selection locked. Press START to run the test.</div>}
    </div>
  )
}
