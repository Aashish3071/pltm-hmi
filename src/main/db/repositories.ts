import type { ModelConfig, SpeedSettings, TestRunSummary, UserAccount } from '@shared/types'
import { getDb } from './index'

interface UserRow {
  id: number
  slot: string
  display_name: string
  password_hash: string
  role: 'admin' | 'operator'
}

export const usersRepo = {
  list(): UserAccount[] {
    const rows = getDb()
      .prepare('SELECT id, slot, display_name, role FROM users ORDER BY id')
      .all() as Omit<UserRow, 'password_hash'>[]
    return rows.map((r) => ({
      id: r.id,
      slot: r.slot,
      displayName: r.display_name,
      role: r.role
    }))
  },

  findByName(name: string): UserRow | undefined {
    return getDb()
      .prepare('SELECT * FROM users WHERE display_name = ? COLLATE NOCASE OR slot = ? COLLATE NOCASE')
      .get(name, name) as UserRow | undefined
  },

  findById(id: number): UserRow | undefined {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  },

  rename(id: number, displayName: string): void {
    getDb()
      .prepare("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?")
      .run(displayName, id)
  },

  setPasswordHash(id: number, hash: string): void {
    getDb()
      .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hash, id)
  }
}

interface ModelRow {
  id: number
  name: string
  distance_mm: number
}

function withPoints(rows: ModelRow[]): ModelConfig[] {
  const pointsStmt = getDb().prepare(
    'SELECT row_index, load_n, height_mm FROM model_points WHERE model_id = ? ORDER BY row_index'
  )
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    distanceMm: m.distance_mm,
    points: (
      pointsStmt.all(m.id) as { row_index: number; load_n: number; height_mm: number }[]
    ).map((p) => ({ rowIndex: p.row_index, loadN: p.load_n, heightMm: p.height_mm }))
  }))
}

export const modelsRepo = {
  /** Active (non-archived) models. */
  list(): ModelConfig[] {
    const rows = getDb()
      .prepare('SELECT id, name, distance_mm FROM models WHERE archived = 0 ORDER BY id')
      .all() as ModelRow[]
    return withPoints(rows)
  },

  /** An active model, or undefined if it does not exist or was deleted. */
  get(id: number): ModelConfig | undefined {
    const row = getDb()
      .prepare('SELECT id, name, distance_mm FROM models WHERE id = ? AND archived = 0')
      .get(id) as ModelRow | undefined
    return row ? withPoints([row])[0] : undefined
  },

  /** Any model including archived ones — used for historical reports. */
  getIncludingArchived(id: number): ModelConfig | undefined {
    const row = getDb()
      .prepare('SELECT id, name, distance_mm FROM models WHERE id = ?')
      .get(id) as ModelRow | undefined
    return row ? withPoints([row])[0] : undefined
  },

  /** Id of any model (active or archived) holding this name, case-insensitively. */
  idByName(name: string): number | undefined {
    const row = getDb()
      .prepare('SELECT id FROM models WHERE name = ? COLLATE NOCASE')
      .get(name) as { id: number } | undefined
    return row?.id
  },

  save(model: Omit<ModelConfig, 'id'> & { id?: number }): number {
    const db = getDb()
    const run = db.transaction(() => {
      let id = model.id
      if (id) {
        db.prepare(
          "UPDATE models SET name = ?, distance_mm = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(model.name, model.distanceMm, id)
      } else {
        id = Number(
          db.prepare('INSERT INTO models (name, distance_mm) VALUES (?, ?)').run(
            model.name,
            model.distanceMm
          ).lastInsertRowid
        )
      }
      db.prepare('DELETE FROM model_points WHERE model_id = ?').run(id)
      const insertPoint = db.prepare(
        'INSERT INTO model_points (model_id, row_index, load_n, height_mm) VALUES (?, ?, ?, ?)'
      )
      for (const p of model.points) insertPoint.run(id, p.rowIndex, p.loadN, p.heightMm)
      return id
    })
    return run() as number
  },

  /**
   * Archives the model so historical runs still resolve it. The name gets a
   * suffix so it can be reused for a new model.
   */
  archive(id: number): void {
    getDb()
      .prepare(
        "UPDATE models SET archived = 1, name = name || ' (deleted #' || id || ')', updated_at = datetime('now') WHERE id = ?"
      )
      .run(id)
  }
}

export const settingsRepo = {
  getAll(): Record<string, string> {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
      key: string
      value: string
    }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  },

  get(key: string): string | undefined {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value
  },

  set(key: string, value: string): void {
    getDb()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  },

  getSpeeds(): SpeedSettings {
    const all = settingsRepo.getAll()
    return {
      up: Number(all.up_speed_mm_s ?? 50),
      down: Number(all.down_speed_mm_s ?? 50),
      jog: Number(all.jog_speed_mm_s ?? 50)
    }
  },

  setSpeeds(speeds: SpeedSettings): void {
    settingsRepo.set('up_speed_mm_s', String(speeds.up))
    settingsRepo.set('down_speed_mm_s', String(speeds.down))
    settingsRepo.set('jog_speed_mm_s', String(speeds.jog))
  }
}

export const testRunsRepo = {
  create(input: {
    employeeUserId: number
    modelId: number
    partNo: string
  }): number {
    return Number(
      getDb()
        .prepare(
          "INSERT INTO test_runs (employee_user_id, model_id, part_no, started_at) VALUES (?, ?, ?, datetime('now'))"
        )
        .run(input.employeeUserId, input.modelId, input.partNo).lastInsertRowid
    )
  },

  addPoints(runId: number, points: { tMs: number; loadN: number; heightMm: number; phase: string }[]): void {
    const db = getDb()
    const stmt = db.prepare(
      'INSERT INTO test_run_points (test_run_id, t_ms, load_n, height_mm, phase) VALUES (?, ?, ?, ?, ?)'
    )
    const insertMany = db.transaction(() => {
      for (const p of points) stmt.run(runId, p.tMs, p.loadN, p.heightMm, p.phase)
    })
    insertMany()
  },

  finish(
    runId: number,
    input: { upCycleSec: number; downCycleSec: number; maxLoadN: number; resultStatus: string }
  ): void {
    getDb()
      .prepare(
        "UPDATE test_runs SET ended_at = datetime('now'), up_cycle_sec = ?, down_cycle_sec = ?, max_load_n = ?, result_status = ? WHERE id = ?"
      )
      .run(input.upCycleSec, input.downCycleSec, input.maxLoadN, input.resultStatus, runId)
  },

  setReportPath(runId: number, path: string): void {
    getDb().prepare('UPDATE test_runs SET report_path = ? WHERE id = ?').run(path, runId)
  },

  get(runId: number): TestRunSummary | undefined {
    const row = getDb()
      .prepare(
        `SELECT r.id, u.display_name AS employee_name, m.name AS model_name, r.part_no,
                r.started_at, r.ended_at, r.up_cycle_sec, r.down_cycle_sec, r.max_load_n,
                r.result_status, r.report_path
         FROM test_runs r
         LEFT JOIN users u ON u.id = r.employee_user_id
         LEFT JOIN models m ON m.id = r.model_id
         WHERE r.id = ?`
      )
      .get(runId) as Record<string, unknown> | undefined
    return row ? mapRunSummary(row) : undefined
  },

  lastCompleted(): TestRunSummary | undefined {
    const row = getDb()
      .prepare(
        `SELECT r.id, u.display_name AS employee_name, m.name AS model_name, r.part_no,
                r.started_at, r.ended_at, r.up_cycle_sec, r.down_cycle_sec, r.max_load_n,
                r.result_status, r.report_path
         FROM test_runs r
         LEFT JOIN users u ON u.id = r.employee_user_id
         LEFT JOIN models m ON m.id = r.model_id
         WHERE r.ended_at IS NOT NULL
         ORDER BY r.id DESC LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined
    return row ? mapRunSummary(row) : undefined
  },

  modelIdOf(runId: number): number | null {
    const row = getDb().prepare('SELECT model_id FROM test_runs WHERE id = ?').get(runId) as
      | { model_id: number | null }
      | undefined
    return row?.model_id ?? null
  },

  points(runId: number): { tMs: number; loadN: number; heightMm: number; phase: string }[] {
    const rows = getDb()
      .prepare('SELECT t_ms, load_n, height_mm, phase FROM test_run_points WHERE test_run_id = ? ORDER BY t_ms')
      .all(runId) as { t_ms: number; load_n: number; height_mm: number; phase: string }[]
    return rows.map((r) => ({ tMs: r.t_ms, loadN: r.load_n, heightMm: r.height_mm, phase: r.phase }))
  }
}

function mapRunSummary(row: Record<string, unknown>): TestRunSummary {
  return {
    id: row.id as number,
    employeeName: (row.employee_name as string) ?? null,
    modelName: (row.model_name as string) ?? null,
    partNo: (row.part_no as string) ?? null,
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) ?? null,
    upCycleSec: (row.up_cycle_sec as number) ?? null,
    downCycleSec: (row.down_cycle_sec as number) ?? null,
    maxLoadN: (row.max_load_n as number) ?? null,
    resultStatus: (row.result_status as string) ?? null,
    reportPath: (row.report_path as string) ?? null
  }
}
