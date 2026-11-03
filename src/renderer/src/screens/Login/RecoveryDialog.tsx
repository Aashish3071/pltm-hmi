import { useEffect, useState, type FormEvent } from 'react'
import type { RecoveryRequest } from '@shared/types'
import { api } from '../../api/client'

interface Props {
  onClose: () => void
  onDone: () => void
}

/**
 * Forgotten ADMIN password. The operator reads the machine ID and request
 * code to Novatek support, types in the response code they are given, and
 * chooses a new ADMIN password.
 */
export default function RecoveryDialog({ onClose, onDone }: Props): JSX.Element {
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
    // After too many wrong codes or expiry the main process makes a new request code.
    void loadRequest()
  }

  return (
    <div className="modal-backdrop">
      <form className="modal wide" onSubmit={submit}>
        <div className="modal-title">RESET ADMIN PASSWORD</div>
        <div className="modal-inner left recovery">
          <div>Call Novatek support and read out these two codes:</div>
          <div className="recovery-codes">
            <span>MACHINE ID</span>
            <b>{request?.machineId ?? '…'}</b>
            <span>REQUEST CODE</span>
            <b className="request-code">{request?.requestCode ?? '…'}</b>
          </div>
          <div className="hint">
            The request code is valid for 30 minutes
            {request ? ` (until ${new Date(request.expiresAt).toLocaleTimeString()})` : ''}.
          </div>
          <label>
            RESPONSE CODE FROM SUPPORT
            <input
              autoFocus
              placeholder="XXXXX-XXXXX"
              value={response}
              onChange={(e) => setResponse(e.target.value.toUpperCase())}
            />
          </label>
          <label>
            NEW ADMIN PASSWORD
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label>
            CONFIRM NEW PASSWORD
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          {error && <div className="login-error">{error}</div>}
          <div className="row-actions">
            <button className="btn green" type="submit" disabled={busy || !response || !password}>
              {busy ? 'CHECKING…' : 'RESET PASSWORD'}
            </button>
            <button className="btn" type="button" onClick={onClose}>
              CANCEL
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}
