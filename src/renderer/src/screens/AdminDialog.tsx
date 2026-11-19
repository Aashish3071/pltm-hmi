import { useEffect, useState } from 'react'
import type { SystemInfo } from '@shared/types'
import { api } from '../api/client'
import { critical } from '../components/MessageBox'
import { Icon } from '../components/Icons'

const DRIVER: Record<string, string> = {
  s7: 'Siemens S7 (Ethernet)',
  controller: 'PantoCheck controller',
  modbus: 'Modbus',
  simulator: 'Simulator'
}

/** SETTINGS asks for the administrator's name and password, and shows the system details. */
export default function AdminDialog({ onUnlocked, onClose }: { onUnlocked: () => void; onClose: () => void }): JSX.Element {
  const [username, setUsername] = useState('ADMIN')
  const [password, setPassword] = useState('')
  const [info, setInfo] = useState<SystemInfo | null>(null)

  useEffect(() => {
    void api.app.systemInfo().then((r) => r.ok && setInfo(r.data))
  }, [])

  const ok = async (): Promise<void> => {
    const result = await api.auth.adminCheck(username, password)
    if (result.ok) {
      onUnlocked()
      return
    }
    await critical('Access denied', 'Incorrect administrator name or password.')
    setPassword('')
  }

  return (
    <div className="modal-backdrop">
      <div className="dialog" style={{ width: 460 }} role="dialog" aria-label="Administrator">
        <div className="dialog-head">
          <Icon name="lock" size={18} /> Administrator sign-in
          <button className="x" onClick={onClose} title="Close" data-testid="admin-close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form">
            <label>User name</label>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} data-testid="admin-username" />
            <label>Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void ok()}
              autoFocus
              data-testid="admin-password"
            />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              className="btn ghost"
              onClick={() => {
                setUsername('')
                setPassword('')
              }}
            >
              CLEAR
            </button>
            <button className="btn" style={{ minWidth: 110 }} onClick={() => void ok()} data-testid="admin-ok">
              OK
            </button>
          </div>
          <div className="info" data-testid="admin-info">
            <span>Machine ID</span>
            <span>{info?.machineId ?? ''}</span>
            <span>Device IP</span>
            <span data-testid="admin-device">{info?.deviceIp ?? ''}</span>
            <span>Connection</span>
            <span>{info ? DRIVER[info.driver] : ''}</span>
            <span>Load capacity</span>
            <span>{info ? `${info.loadCapacityKg} kg` : ''}</span>
            <span>Height capacity</span>
            <span>{info ? `${info.heightCapacityMm} mm` : ''}</span>
            <span>Version</span>
            <span>{info?.appVersion ?? ''}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
