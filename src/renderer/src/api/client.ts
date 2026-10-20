import type { IpcResult } from '@shared/types'

export class ApiError extends Error {
  constructor(message: string) {
    super(message)
  }
}

/** Unwraps the IpcResult envelope, turning failures into throwable ApiErrors. */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise
  if (!result.ok) throw new ApiError(result.message)
  return result.data
}

export const api = window.pltm
