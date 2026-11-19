import { useEffect, useState } from 'react'
import type { UserAccount } from '@shared/types'
import { PRODUCT_NAME } from '@shared/brand'
import { api } from '../api/client'
import { Brand } from '../components/Header'
import { critical, information } from '../components/MessageBox'
import { Icon } from '../components/Icons'
import RecoveryDialog from './RecoveryDialog'

export default function LoginScreen({ onLogin, onExit }: { onLogin: (user: UserAccount) => void; onExit: () => void }): JSX.Element {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState('')
  const [recovering, setRecovering] = useState(false)

  useEffect(() => {
    void api.app.systemInfo().then((r) => r.ok && setVersion(r.data.appVersion))
  }, [])

  const login = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const result = await api.auth.login(username, password)
    setBusy(false)
    if (result.ok) {
      onLogin(result.data)
      return
    }
    await critical('Login failed', 'Incorrect user name or password.')
    setUsername('')
    setPassword('')
  }

  const enter = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') void login()
  }

  return (
    <div className="login">
      <svg className="login-art" width="520" height="520" viewBox="0 0 512 512" aria-hidden="true">
        <g fill="none" stroke="white" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round">
          <path d="M120 110h272 M160 110v40 M352 110v40 M256 160L150 300l66 92 M256 160l106 140-66 92 M112 410h288" />
        </g>
      </svg>
      <div className="login-card">
        <Brand />
        <div style={{ height: 4 }} />
        <div>
          <div className="field-label">User name</div>
          <input
            className="input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={enter}
            autoFocus
            data-testid="login-username"
          />
        </div>
        <div>
          <div className="field-label">Password</div>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={enter}
            data-testid="login-password"
          />
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn" style={{ flex: 1, height: 44 }} onClick={() => void login()} disabled={busy} data-testid="login-button">
            <Icon name="user" /> LOGIN
          </button>
          <button className="btn ghost" style={{ width: 120, height: 44 }} onClick={onExit} data-testid="exit-button">
            EXIT
          </button>
        </div>
        <button className="link" style={{ alignSelf: 'center' }} onClick={() => setRecovering(true)} data-testid="forgot-admin">
          Forgot ADMIN password?
        </button>
      </div>
      {recovering && (
        <RecoveryDialog
          onClose={() => setRecovering(false)}
          onDone={() => {
            setRecovering(false)
            void information('Password reset', 'The ADMIN password has been changed. Log in with the new password.')
          }}
        />
      )}
      <div className="login-foot">
        {PRODUCT_NAME} {version && `v${version}`}
      </div>
    </div>
  )
}
