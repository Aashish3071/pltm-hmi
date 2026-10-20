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

export function login(username: string, password: string): UserAccount | null {
  const row = usersRepo.findByName(String(username ?? '').trim())
  if (!row) return null
  if (!bcrypt.compareSync(String(password ?? ''), row.password_hash)) return null
  return { id: row.id, slot: row.slot, displayName: row.display_name, role: row.role }
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

export function isAdminPassword(password: string): boolean {
  const admin = usersRepo.list().find((u) => u.role === 'admin')
  if (!admin) return false
  const row = usersRepo.findById(admin.id)
  return !!row && bcrypt.compareSync(String(password ?? ''), row.password_hash)
}

/** The settings page needs the admin password even when someone else is logged in. */
export function unlockAdmin(password: string): boolean {
  if (!session.user || !isAdminPassword(password)) return false
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
