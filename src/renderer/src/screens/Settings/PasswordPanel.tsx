import { useEffect, useState } from 'react'
import type { UserAccount } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'

interface Props {
  users: UserAccount[]
}

export default function PasswordPanel({ users }: Props): JSX.Element {
  const [userId, setUserId] = useState<number>(users[0]?.id ?? 0)
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (!users.some((u) => u.id === userId)) setUserId(users[0]?.id ?? 0)
  }, [users, userId])

  const change = async (): Promise<void> => {
    if (password.length < 4) {
      toast.error('Password must be at least 4 characters.')
      return
    }
    const result = await api.users.changePassword(userId, password)
    if (result.ok) {
      setPassword('')
      toast.success('Password changed.')
    } else {
      toast.error(result.message)
    }
  }

  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#128272;</span> PASSWORD
      </div>
      <div className="field-row">
        <label>USERNAME</label>
        <select value={userId} onChange={(e) => setUserId(Number(e.target.value))}>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <label>PASSWORD</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password"
        />
      </div>
      <button className="btn yellow small" onClick={change}>
        CHANGE
      </button>
    </div>
  )
}
