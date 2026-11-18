import bcrypt from 'bcryptjs'
import { ErrorCode, type UserAccount } from '@shared/types'
import { usersRepo } from '../db/repositories'
import { CommandError } from '../errors'

/**
 * Main-process session. The renderer's view of who is logged in is not
 * trusted; admin-only IPC handlers check this instead.
 */
const session: { user: UserAccount | null; adminUnlocked: boolean } = {
  user: null,
  adminUnlocked: false
}

function toAccount(row: { id: number; slot: string; display_name: string; role: 'admin' | 'operator' }): UserAccount {
  return { id: row.id, slot: row.slot, displayName: row.display_name, role: row.role }
}

/** The name must be one of the four employees, with that employee's password. */
export function login(username: string, password: string): UserAccount | null {
  const row = usersRepo.findByName(String(username ?? ''))
  if (!row) return null
  if (!bcrypt.compareSync(String(password ?? ''), row.password_hash)) return null
  return toAccount(row)
}

export function startSession(user: UserAccount): void {
  session.user = user
  session.adminUnlocked = false
}

export function endSession(): void {
  session.user = null
  session.adminUnlocked = false
}

export function currentUser(): UserAccount | null {
  return session.user
}

/**
 * The first employee's name and password open Settings,
 * whoever is logged in.
 */
export function unlockAdmin(username: string, password: string): boolean {
  if (!session.user) return false
  const first = usersRepo.list()[0]
  if (!first || first.displayName !== String(username ?? '')) return false
  const row = usersRepo.findById(first.id)
  if (!row || !bcrypt.compareSync(String(password ?? ''), row.password_hash)) return false
  session.adminUnlocked = true
  return true
}

export function lockAdmin(): void {
  session.adminUnlocked = false
}

export function requireUser(): UserAccount {
  if (!session.user) throw new CommandError(ErrorCode.NOT_AUTHORIZED, 'Please log in first.')
  return session.user
}

export function requireAdmin(): void {
  requireUser()
  if (!session.adminUnlocked) throw new CommandError(ErrorCode.NOT_AUTHORIZED)
}

export function changePassword(userId: number, newPassword: string): void {
  usersRepo.setPasswordHash(userId, bcrypt.hashSync(newPassword, 10))
}
