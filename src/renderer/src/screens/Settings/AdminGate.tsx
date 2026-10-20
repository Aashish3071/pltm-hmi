import { useEffect, useState, type FormEvent } from 'react'
import type { SystemInfo } from '@shared/types'
import { api } from '../../api/client'

interface Props {
  onPass: () => void
  onCancel: () => void
}

export default function AdminGate({ onPass, onCancel }: Props): JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    void api.app.systemInfo().then((result) => {
      if (result.ok) setInfo(result.data)
    })
  }, [])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const result = await api.auth.adminCheck(password)
    if (result.ok) onPass()
    else {
      setError(result.message)
      setPassword('')
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal" onSubmit={submit}>
        <div className="modal-title">ADMIN LOGIN</div>
        <div className="modal-inner">
          <input value="ADMIN" readOnly />
          <input
            autoFocus
            type="password"
            placeholder="PASSWORD"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn green" type="submit">
              OK
            </button>
            <button className="btn red" type="button" onClick={onCancel}>
              CANCEL
            </button>
          </div>
          {error && <div style={{ color: '#a61e1e', fontSize: 12 }}>{error}</div>}
          <div className="version-note">Version {info?.appVersion ?? '-'}</div>
        </div>
        {info && (
          <div className="info-block">
            <div className="row">
              <span>MACHINE ID</span>
              <span>{info.machineId}</span>
            </div>
            <div className="row">
              <span>DEVICE IP</span>
              <span>{info.deviceIp}</span>
            </div>
            <div className="row">
              <span>DRIVER</span>
              <span>{info.driver === 'modbus' ? 'MODBUS' : 'SIMULATOR'}</span>
            </div>
            <div className="row">
              <span>Load Capacity</span>
              <span>{info.loadCapacityN} N</span>
            </div>
            <div className="row">
              <span>Height Capacity</span>
              <span>{info.heightCapacityMm} mm</span>
            </div>
          </div>
        )}
      </form>
    </div>
  )
}
