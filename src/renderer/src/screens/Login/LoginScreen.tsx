import { useState, type FormEvent } from 'react'
import type { UserAccount } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'
import RecoveryDialog from './RecoveryDialog'

interface Props {
  onLogin: (user: UserAccount) => void
}

export default function LoginScreen({ onLogin }: Props): JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [recovering, setRecovering] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError('')
    const result = await api.auth.login(username, password)
    setBusy(false)
    if (result.ok) onLogin(result.data)
    else {
      setError(result.message)
      setPassword('')
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-avatar">&#128100;</div>
        <input
          autoFocus
          placeholder="USER NAME"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          type="password"
          placeholder="PASSWORD"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="login-error">{error}</div>}
        <div className="login-buttons">
          <button className="btn green" type="submit" disabled={busy}>
            LOGIN
          </button>
          <button className="btn red" type="button" onClick={() => api.app.quit()}>
            EXIT
          </button>
        </div>
        <button type="button" className="link-btn" onClick={() => setRecovering(true)}>
          FORGOT ADMIN PASSWORD?
        </button>
      </form>
      <div className="login-footer">Powered by Novatek</div>
      {recovering && (
        <RecoveryDialog
          onClose={() => setRecovering(false)}
          onDone={() => {
            setRecovering(false)
            setUsername('ADMIN')
            toast.success('ADMIN password changed. Log in with the new password.')
          }}
        />
      )}
    </div>
  )
}
