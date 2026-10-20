import { ERROR_MESSAGES, type ErrorCode } from '@shared/types'

/** An expected failure that is reported to the operator rather than logged as a bug. */
export class CommandError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string
  ) {
    super(message ?? ERROR_MESSAGES[code])
  }
}
