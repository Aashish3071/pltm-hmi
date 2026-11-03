import { ErrorCode, type RecoveryRequest } from '@shared/types'
import { settingsRepo, usersRepo } from '../db/repositories'
import { CommandError } from '../errors'
import { log } from '../logger'
import { changePassword } from './configService'
import { DEV_RECOVERY_SECRET, newRequestCode, responseMatches } from './recoveryCode'

/**
 * Forgotten ADMIN password: the login screen shows a request code and the
 * machine ID; the vendor answers with a response code (npm run
 * recovery-code), which lets the operator set a new ADMIN password.
 *
 * The vendor secret is compiled in at build time from PLTM_RECOVERY_SECRET.
 * Builds without it use a development key that is public in the source code,
 * so release builds must set it (the Windows release workflow enforces this).
 */
declare const __PLTM_RECOVERY_SECRET__: string | undefined

const BUILD_SECRET = typeof __PLTM_RECOVERY_SECRET__ === 'string' ? __PLTM_RECOVERY_SECRET__ : ''

export function recoverySecret(): string {
  return BUILD_SECRET || DEV_RECOVERY_SECRET
}

export function usingDevRecoverySecret(): boolean {
  return !BUILD_SECRET
}

const VALID_MS = 30 * 60 * 1000
const MAX_ATTEMPTS = 5

let pending: { code: string; machineId: string; expiresAt: number; attempts: number } | null = null

function machineId(): string {
  return settingsRepo.get('machine_id') ?? 'PLTM-0001'
}

/** The current request code, or a new one if there is none or it expired. */
export function getRecoveryRequest(): RecoveryRequest {
  if (!pending || pending.expiresAt < Date.now() || pending.machineId !== machineId()) {
    pending = { code: newRequestCode(), machineId: machineId(), expiresAt: Date.now() + VALID_MS, attempts: 0 }
    log.warn(`Admin password recovery requested (request code ${pending.code})`)
  }
  return {
    requestCode: pending.code,
    machineId: pending.machineId,
    expiresAt: new Date(pending.expiresAt).toISOString()
  }
}

/** Checks the vendor's response code and, if right, sets the new ADMIN password. */
export function completeRecovery(response: string, newPassword: string): void {
  const fail = (message: string): never => {
    throw new CommandError(ErrorCode.INVALID_CREDENTIALS, message)
  }
  if (!pending || pending.expiresAt < Date.now()) {
    pending = null
    fail('The request code has expired. Read the new request code to support.')
  }
  const request = pending!
  request.attempts++
  if (!responseMatches(recoverySecret(), request.code, request.machineId, response)) {
    log.warn(`Wrong admin recovery response code (attempt ${request.attempts})`)
    if (request.attempts >= MAX_ATTEMPTS) {
      pending = null
      fail('Too many wrong response codes. A new request code has been made; read it to support.')
    }
    fail('That response code is not right for this request code. Check it and try again.')
  }
  const admin = usersRepo.list().find((u) => u.role === 'admin')
  if (!admin) fail('No administrator account was found.')
  changePassword(admin!.id, newPassword)
  pending = null
  log.warn('ADMIN password reset with a recovery code')
}
