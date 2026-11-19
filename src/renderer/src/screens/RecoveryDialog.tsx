import { useEffect, useState, type FormEvent } from 'react'
import type { RecoveryRequest } from '@shared/types'
import { PRODUCT_NAME } from '@shared/brand'
import { api } from '../api/client'
import { Icon } from '../components/Icons'

/**
 * Forgotten ADMIN password: the operator reads the machine ID and request code
 * to support, types in the response code they are given, and chooses a new
 * ADMIN password.
 */
export default function RecoveryDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [request, setRequest] = useState<RecoveryRequest | null>(null)
  const [response, setResponse] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const loadRequest = async (): Promise<void> => {
    const result = await api.auth.recoveryRequest()
    if (result.ok) setRequest(result.data)
    else setError(result.message)
  }

  useEffect(() => {
    void loadRequest()
  }, [])

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('The two new passwords do not match.')
      return
    }
    setBusy(true)
    const result = await api.auth.recoveryComplete(response, password)
    setBusy(false)
    if (result.ok) {
      onDone()
      return
    }
    setError(result.message)
    // After too many wrong codes or expiry a new request code is made.
    void loadRequest()
  }

  return (
    <div className="modal-backdrop">
      <form className="dialog" style={{ width: 500 }} onSubmit={submit} data-testid="recovery-dialog">
        <div className="dialog-head">
          <Icon name="lock" size={18} /> Reset ADMIN password
          <button type="button" className="x" onClick={onClose} title="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="dialog-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>Call {PRODUCT_NAME} support and read out these two codes:</div>
          <div className="info">
            <span>Machine ID</span>
            <span>{request?.machineId ?? '…'}</span>
            <span>Request code</span>
            <span style={{ fontSize: 18 }} data-testid="recovery-request">
              {request?.requestCode ?? '…'}
            </span>
          </div>
          <div className="note">
            The request code is valid for 30 minutes
            {request ? ` (until ${new Date(request.expiresAt).toLocaleTimeString()})` : ''}.
          </div>
          <div className="form" style={{ gridTemplateColumns: '170px 1fr' }}>
            <label>Response code</label>
            <input
              className="input"
              autoFocus
              placeholder="XXXXX-XXXXX"
              value={response}
              onChange={(e) => setResponse(e.target.value.toUpperCase())}
              data-testid="recovery-response"
            />
            <label>New ADMIN password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="recovery-password" />
            <label>Confirm password</label>
            <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} data-testid="recovery-confirm" />
          </div>
          {error && (
            <div className="note" style={{ color: 'var(--red)' }} data-testid="recovery-error">
              {error}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" type="button" onClick={onClose}>
              CANCEL
            </button>
            <button className="btn" type="submit" disabled={busy || !response || !password} data-testid="recovery-submit">
              {busy ? 'CHECKING…' : 'RESET PASSWORD'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
