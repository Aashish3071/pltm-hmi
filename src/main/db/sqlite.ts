import { DatabaseSync, type SQLInputValue, type StatementResultingChanges } from 'node:sqlite'

/** Rows come back untyped, as with better-sqlite3; callers cast them. */
export interface Statement {
  run(...params: SQLInputValue[]): StatementResultingChanges
  get(...params: SQLInputValue[]): unknown
  all(...params: SQLInputValue[]): unknown[]
}

/**
 * Thin wrapper over Node's built-in SQLite (bundled with Electron) giving the
 * small part of the better-sqlite3 API this app uses: prepare/exec plus
 * pragma() and transaction(). Using the built-in driver means the app ships no
 * native database module, so nothing has to be compiled per platform or per
 * Electron version.
 */
export class Database {
  private readonly db: DatabaseSync
  private depth = 0

  constructor(file: string) {
    this.db = new DatabaseSync(file)
  }

  prepare(sql: string): Statement {
    return this.db.prepare(sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  /**
   * Runs a PRAGMA. With `simple`, returns the first column of the first row
   * (e.g. `pragma('user_version', { simple: true })` → 3).
   */
  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const rows = this.db.prepare(`PRAGMA ${source}`).all() as Record<string, unknown>[]
    if (!options.simple) return rows
    const first = rows[0]
    return first ? Object.values(first)[0] : undefined
  }

  /**
   * Wraps fn in a transaction: committed if it returns, rolled back if it
   * throws. Nested calls use savepoints, as better-sqlite3 does.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const savepoint = `sp_${this.depth}`
      const outer = this.depth === 0
      this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
      this.depth++
      try {
        const result = fn(...args)
        this.depth--
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`)
        return result
      } catch (error) {
        this.depth--
        this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
        throw error
      }
    }
  }

  /** Copies the whole database to `file` (a consistent snapshot, safe while in use). */
  backupTo(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file)
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }
}
