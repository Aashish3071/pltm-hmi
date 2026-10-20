import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const MAX_BYTES = 5 * 1024 * 1024

let file: string | null = null

function logFile(): string {
  if (!file) {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'pltm.log')
  }
  return file
}

export function logPath(): string {
  return logFile()
}

function write(level: string, message: string, detail?: unknown): void {
  const extra =
    detail instanceof Error
      ? ` ${detail.stack ?? detail.message}`
      : detail !== undefined
        ? ` ${safeJson(detail)}`
        : ''
  const line = `${new Date().toISOString()} [${level}] ${message}${extra}\n`
  if (level === 'ERROR') console.error(line.trimEnd())
  try {
    const target = logFile()
    if (existsSync(target) && statSync(target).size > MAX_BYTES) renameSync(target, `${target}.1`)
    appendFileSync(target, line)
  } catch {
    // Logging must never take the app down.
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const log = {
  info: (message: string, detail?: unknown) => write('INFO', message, detail),
  warn: (message: string, detail?: unknown) => write('WARN', message, detail),
  error: (message: string, detail?: unknown) => write('ERROR', message, detail)
}
