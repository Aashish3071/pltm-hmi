import { useEffect, useState } from 'react'
import type { UserAccount } from '@shared/types'
import { api } from '../../api/client'
import { toast } from '../../state/toastStore'

interface Props {
  users: UserAccount[]
  onUsersChange: (users: UserAccount[]) => void
}

export default function UsersPanel({ users, onUsersChange }: Props): JSX.Element {
  const [names, setNames] = useState<Record<number, string>>({})

  useEffect(() => {
    setNames(Object.fromEntries(users.map((u) => [u.id, u.displayName])))
  }, [users])

  const save = async (): Promise<void> => {
    let latest = users
    for (const user of users) {
      const next = names[user.id]?.trim()
      if (!next || next === user.displayName) continue
      const result = await api.users.rename(user.id, next)
      if (!result.ok) {
        toast.error(result.message)
        return
      }
      latest = result.data
    }
    onUsersChange(latest)
    toast.success('User names saved.')
  }

  return (
    <div className="panel orange">
      <div className="section-title">
        <span className="glyph">&#128104;</span> USERS
      </div>
      {users.map((user, i) => (
        <div className="user-row" key={user.id}>
          <span className="idx">{i + 1}.</span>
          <input
            value={names[user.id] ?? ''}
            onChange={(e) => setNames((prev) => ({ ...prev, [user.id]: e.target.value }))}
          />
        </div>
      ))}
      <button className="btn yellow small" onClick={save}>
        SAVE
      </button>
    </div>
  )
}
