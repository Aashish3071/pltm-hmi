import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { ErrorCode, type BackupInfo, type BackupKind, type BackupStatus } from '@shared/types'
import { closeDb, dbPath, getDb, isDbOpen } from '../db'
import { MIGRATIONS } from '../db/schema'
import { CommandError } from '../errors'
import { log } from '../logger'

/**
 * Backups are folders named PLTM-backup-<date>_<time>-<kind>, each holding a
 * consistent copy of the database (pltm.db), the attached load-cell
 * certificate files (certificates/) and a small backup.json.
 *
 * Where backups go is kept in userData/backup-settings.json rather than in the
 * database, so a damaged database can still be restored from them at startup.
 */

const PREFIX = 'PLTM-backup-'
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000
const CHECK_EVERY_MS = 30 * 60 * 1000
const DEFAULT_KEEP = 30

interface BackupSettings {
  dir?: string
  keep?: number
}

let lastError: string | null = null
let timer: NodeJS.Timeout | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'backup-settings.json')
}

function readSettings(): BackupSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as BackupSettings
  } catch {
    return {}
  }
}

function writeSettings(settings: BackupSettings): void {
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
}

export function backupDir(): string {
  const configured = readSettings().dir
  return configured && configured.trim() ? configured : join(app.getPath('documents'), 'PLTM Backups')
}

export function setBackupDir(dir: string): void {
  writeSettings({ ...readSettings(), dir })
}

function keepCount(): number {
  const keep = Number(readSettings().keep)
  return Number.isInteger(keep) && keep > 0 ? keep : DEFAULT_KEEP
}

function certificatesDir(): string {
  return join(app.getPath('userData'), 'certificates')
}

function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  )
}

/** Makes a backup now. Throws BACKUP_FAILED with the reason if it cannot. */
export function createBackup(kind: BackupKind): BackupInfo {
  const createdAt = new Date()
  let folder = join(backupDir(), `${PREFIX}${stamp(createdAt)}-${kind}`)
  // Two backups in the same second (e.g. manual right after pre-restore).
  for (let n = 2; existsSync(folder); n++) folder = join(backupDir(), `${PREFIX}${stamp(createdAt)}-${kind}-${n}`)
  try {
    mkdirSync(folder, { recursive: true })
    getDb().backupTo(join(folder, 'pltm.db'))
    if (existsSync(certificatesDir())) {
      cpSync(certificatesDir(), join(folder, 'certificates'), { recursive: true })
    }
    writeFileSync(
      join(folder, 'backup.json'),
      JSON.stringify({ createdAt: createdAt.toISOString(), kind, appVersion: app.getVersion() }, null, 2)
    )
    lastError = null
    log.info(`Backup written: ${folder}`)
  } catch (error) {
    rmSync(folder, { recursive: true, force: true })
    lastError = error instanceof Error ? error.message : String(error)
    log.error('Backup failed', error)
    throw new CommandError(ErrorCode.BACKUP_FAILED, `The backup could not be made: ${lastError}`)
  }
  pruneAutoBackups()
  return describe(folder)!
}

/** Keeps the newest automatic backups; manual and pre-restore ones are kept. */
function pruneAutoBackups(): void {
  const auto = listBackups().filter((b) => b.kind === 'auto')
  for (const old of auto.slice(keepCount())) {
    try {
      rmSync(old.path, { recursive: true, force: true })
    } catch (error) {
      log.warn(`Could not delete old backup ${old.path}`, error)
    }
  }
}

/** Reads a backup folder's details, or null if it is not a usable backup. */
function describe(folder: string): BackupInfo | null {
  const db = join(folder, 'pltm.db')
  if (!existsSync(db)) return null
  let createdAt = statSync(db).mtime.toISOString()
  let kind: BackupKind = 'manual'
  try {
    const meta = JSON.parse(readFileSync(join(folder, 'backup.json'), 'utf8'))
    if (typeof meta.createdAt === 'string') createdAt = meta.createdAt
    if (['auto', 'manual', 'pre-restore'].includes(meta.kind)) kind = meta.kind
  } catch {
    // A database copied in by hand still counts.
  }
  let testRuns: number | null = null
  try {
    const probe = new DatabaseSync(db, { readOnly: true })
    testRuns = (probe.prepare('SELECT COUNT(*) AS n FROM test_runs').get() as { n: number }).n
    probe.close()
  } catch {
    testRuns = null
  }
  return { name: basename(folder), path: folder, createdAt, kind, sizeBytes: statSync(db).size, testRuns }
}

/** Backups in the backup folder, newest first. */
export function listBackups(): BackupInfo[] {
  const dir = backupDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith(PREFIX))
    .map((name) => describe(join(dir, name)))
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function getBackupStatus(): BackupStatus {
  const backups = listBackups()
  return {
    dir: backupDir(),
    keep: keepCount(),
    lastBackupAt: backups[0]?.createdAt ?? null,
    lastError,
    backups
  }
}

/**
 * Checks a backup folder can be restored: it holds a database that passes
 * SQLite's integrity check and was made by this or an older version.
 */
export function inspectBackup(folder: string): BackupInfo {
  const info = describe(folder)
  const fail = (why: string): never => {
    throw new CommandError(ErrorCode.INVALID_INPUT, `This is not a usable backup: ${why}`)
  }
  if (!info) return fail('the folder has no pltm.db in it.')
  let probe: DatabaseSync
  try {
    probe = new DatabaseSync(join(folder, 'pltm.db'), { readOnly: true })
  } catch (error) {
    return fail(`the database cannot be opened (${(error as Error).message}).`)
  }
  try {
    const integrity = (probe.prepare('PRAGMA integrity_check').get() as Record<string, unknown>) ?? {}
    if (Object.values(integrity)[0] !== 'ok') fail('the database is damaged.')
    const version = Number(
      Object.values(probe.prepare('PRAGMA user_version').get() as Record<string, unknown>)[0]
    )
    if (version < 1) fail('it is not a PLTM HMI database.')
    if (version > MIGRATIONS.length) fail('it was made by a newer version of PLTM HMI. Update this PC first.')
    probe.prepare('SELECT COUNT(*) FROM users').get()
    probe.prepare('SELECT COUNT(*) FROM test_runs').get()
  } catch (error) {
    if (error instanceof CommandError) throw error
    fail(`it is not a PLTM HMI database (${(error as Error).message}).`)
  } finally {
    probe.close()
  }
  return info
}

/**
 * Replaces the live data with a backup. The current data is backed up first
 * (when it can be read). The database is left closed: the caller reopens it or
 * restarts the app.
 */
export function restoreBackup(folder: string): BackupInfo {
  const info = inspectBackup(folder)
  if (isDbOpen()) {
    createBackup('pre-restore')
    closeDb()
  }
  const live = dbPath()
  for (const suffix of ['', '-wal', '-shm']) rmSync(live + suffix, { force: true })
  cpSync(join(folder, 'pltm.db'), live)

  rmSync(certificatesDir(), { recursive: true, force: true })
  const certs = join(folder, 'certificates')
  if (existsSync(certs)) cpSync(certs, certificatesDir(), { recursive: true })

  // Certificate files are stored by absolute path; point them at this PC's copy.
  const db = new DatabaseSync(live)
  try {
    const rows = db
      .prepare('SELECT id, file_path FROM load_cell_certificates WHERE file_path IS NOT NULL')
      .all() as { id: number; file_path: string }[]
    const update = db.prepare('UPDATE load_cell_certificates SET file_path = ? WHERE id = ?')
    for (const row of rows) {
      const name = row.file_path.split(/[\\/]/).pop() ?? row.file_path
      const local = join(certificatesDir(), name)
      update.run(existsSync(local) ? local : null, row.id)
    }
  } catch {
    // Older schema without certificates: nothing to fix up.
  } finally {
    db.close()
  }
  log.info(`Restored backup ${folder}`)
  return info
}

/** Finds the newest backup that can be restored (for startup recovery). */
export function latestRestorableBackup(): BackupInfo | null {
  for (const backup of listBackups()) {
    try {
      return inspectBackup(backup.path)
    } catch {
      // Try the next older one.
    }
  }
  return null
}

/**
 * Makes an automatic backup when the newest one is a day old, checking every
 * 30 minutes. `isBusy` defers it while a test is running.
 */
export function startAutoBackup(isBusy: () => boolean): void {
  const tick = (): void => {
    if (isBusy()) return
    const last = listBackups().find((b) => b.kind !== 'pre-restore')
    if (last && Date.now() - Date.parse(last.createdAt) < AUTO_INTERVAL_MS) return
    try {
      createBackup('auto')
    } catch {
      // Logged and shown in Settings → DATA; retried at the next check.
    }
  }
  tick()
  timer = setInterval(tick, CHECK_EVERY_MS)
}

export function stopAutoBackup(): void {
  if (timer) clearInterval(timer)
  timer = null
}
