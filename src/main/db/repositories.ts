import type {
  ModelConfig,
  Sample,
  SpeedSettings,
  TestResults,
  TestRunPage,
  TestRunQuery,
  TestRunSummary,
  UserAccount
} from '@shared/types'
import { getDb } from './index'

export interface UserRow {
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
    return rows.map((r) => ({ id: r.id, slot: r.slot, displayName: r.display_name, role: r.role }))
  },

  /** Log-in matches the typed name against the employee list exactly. */
  findByName(name: string): UserRow | undefined {
    return getDb().prepare('SELECT * FROM users WHERE display_name = ? ORDER BY id LIMIT 1').get(name) as
      | UserRow
      | undefined
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
    points: (pointsStmt.all(m.id) as { row_index: number; load_n: number; height_mm: number }[]).map((p) => ({
      rowIndex: p.row_index,
      loadN: p.load_n,
      heightMm: p.height_mm
    }))
  }))
}

export const modelsRepo = {
  list(): ModelConfig[] {
    const rows = getDb()
      .prepare('SELECT id, name, distance_mm FROM models WHERE archived = 0 ORDER BY id')
      .all() as ModelRow[]
    return withPoints(rows)
  },

  get(id: number): ModelConfig | undefined {
    const row = getDb()
      .prepare('SELECT id, name, distance_mm FROM models WHERE id = ?')
      .get(id) as ModelRow | undefined
    return row ? withPoints([row])[0] : undefined
  },

  idByName(name: string): number | undefined {
    const row = getDb()
      .prepare('SELECT id FROM models WHERE name = ? COLLATE NOCASE AND archived = 0')
      .get(name) as { id: number } | undefined
    return row?.id
  },

  save(model: Omit<ModelConfig, 'id'> & { id?: number }): number {
    const db = getDb()
    return db.transaction(() => {
      let id = model.id
      if (id) {
        db.prepare("UPDATE models SET name = ?, distance_mm = ?, updated_at = datetime('now') WHERE id = ?").run(
          model.name,
          model.distanceMm,
          id
        )
      } else {
        id = Number(
          db.prepare('INSERT INTO models (name, distance_mm) VALUES (?, ?)').run(model.name, model.distanceMm)
            .lastInsertRowid
        )
      }
      db.prepare('DELETE FROM model_points WHERE model_id = ?').run(id)
      const insertPoint = db.prepare(
        'INSERT INTO model_points (model_id, row_index, load_n, height_mm) VALUES (?, ?, ?, ?)'
      )
      for (const p of model.points) insertPoint.run(id, p.rowIndex, p.loadN, p.heightMm)
      return id
    })() as number
  }
}

export const settingsRepo = {
  getAll(): Record<string, string> {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  },

  get(key: string): string | undefined {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
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

export interface TestRunRow {
  id: number
  employeeName: string | null
  modelId: number | null
  modelName: string | null
  partNo: string | null
  startedAt: string
  endedAt: string | null
  upTimeSec: number | null
  downTimeSec: number | null
  resultStatus: string | null
  reportPath: string | null
  results: TestResults | null
}

/** SQLite times are UTC ("YYYY-MM-DD HH:MM:SS"); the UI gets ISO strings. */
function iso(value: string | null): string | null {
  return value ? `${value.replace(' ', 'T')}Z` : null
}

export function toSummary(row: TestRunRow): TestRunSummary {
  return {
    id: row.id,
    employeeName: row.employeeName,
    modelName: row.modelName,
    partNo: row.partNo,
    startedAt: iso(row.startedAt) ?? '',
    endedAt: iso(row.endedAt),
    resultStatus: row.resultStatus,
    reportPath: row.reportPath,
    results: row.results
  }
}

export const testRunsRepo = {
  create(input: { employeeUserId: number | null; modelId: number; partNo: string }): number {
    return Number(
      getDb()
        .prepare(
          "INSERT INTO test_runs (employee_user_id, model_id, part_no, started_at) VALUES (?, ?, ?, datetime('now'))"
        )
        .run(input.employeeUserId, input.modelId, input.partNo).lastInsertRowid
    )
  },

  /** Samples are kept in order; `t_ms` is their sequence number. */
  addSamples(runId: number, firstIndex: number, samples: Sample[]): void {
    const db = getDb()
    const stmt = db.prepare(
      'INSERT INTO test_run_points (test_run_id, t_ms, load_n, height_mm, phase) VALUES (?, ?, ?, ?, ?)'
    )
    db.transaction(() => {
      samples.forEach((s, i) => stmt.run(runId, firstIndex + i, s.loadN, s.positionMm, String(s.code)))
    })()
  },

  samples(runId: number): Sample[] {
    const rows = getDb()
      .prepare('SELECT load_n, height_mm, phase FROM test_run_points WHERE test_run_id = ? ORDER BY t_ms')
      .all(runId) as { load_n: number; height_mm: number; phase: string }[]
    return rows.map((r) => ({ loadN: r.load_n, positionMm: r.height_mm, code: Number(r.phase) || 0 }))
  },

  sampleCount(runId: number): number {
    return (
      getDb().prepare('SELECT COUNT(*) AS n FROM test_run_points WHERE test_run_id = ?').get(runId) as { n: number }
    ).n
  },

  finish(runId: number, input: { upTimeSec: number; downTimeSec: number; status: string; results: TestResults }): void {
    getDb()
      .prepare(
        "UPDATE test_runs SET ended_at = datetime('now'), up_cycle_sec = ?, down_cycle_sec = ?, result_status = ?, results_json = ?, max_load_n = ? WHERE id = ?"
      )
      .run(input.upTimeSec, input.downTimeSec, input.status, JSON.stringify(input.results), null, runId)
  },

  setReportPath(runId: number, path: string): void {
    getDb().prepare('UPDATE test_runs SET report_path = ? WHERE id = ?').run(path, runId)
  },

  /** Finished tests matching the query, newest first, with the total match count. */
  search(query: TestRunQuery): TestRunPage {
    const where = ['r.ended_at IS NOT NULL']
    const params: (string | number)[] = []
    const partNo = String(query.partNo ?? '').trim()
    if (partNo) {
      where.push("r.part_no LIKE ? ESCAPE '\\'")
      params.push(`%${partNo.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    }
    if (query.modelId) {
      where.push('r.model_id = ?')
      params.push(Number(query.modelId))
    }
    // started_at is stored in UTC; filter on the operator's local calendar date.
    if (query.fromDate) {
      where.push("date(r.started_at, 'localtime') >= ?")
      params.push(String(query.fromDate))
    }
    if (query.toDate) {
      where.push("date(r.started_at, 'localtime') <= ?")
      params.push(String(query.toDate))
    }
    if (query.resultStatus) {
      where.push('r.result_status = ?')
      params.push(String(query.resultStatus))
    }
    const filter = where.join(' AND ')
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500)
    const offset = Math.max(Number(query.offset) || 0, 0)
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM test_runs r WHERE ${filter}`).get(...params) as { n: number }).n
    const ids = getDb()
      .prepare(`SELECT r.id FROM test_runs r WHERE ${filter} ORDER BY r.id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as { id: number }[]
    return { runs: ids.map((r) => toSummary(testRunsRepo.get(r.id)!)), total }
  },

  get(runId: number): TestRunRow | undefined {
    const row = getDb()
      .prepare(
        `SELECT r.id, u.display_name AS employee_name, r.model_id, m.name AS model_name, r.part_no,
                r.started_at, r.ended_at, r.up_cycle_sec, r.down_cycle_sec, r.result_status, r.results_json, r.report_path
         FROM test_runs r
         LEFT JOIN users u ON u.id = r.employee_user_id
         LEFT JOIN models m ON m.id = r.model_id
         WHERE r.id = ?`
      )
      .get(runId) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      id: row.id as number,
      employeeName: (row.employee_name as string) ?? null,
      modelId: (row.model_id as number) ?? null,
      modelName: (row.model_name as string) ?? null,
      partNo: (row.part_no as string) ?? null,
      startedAt: row.started_at as string,
      endedAt: (row.ended_at as string) ?? null,
      upTimeSec: (row.up_cycle_sec as number) ?? null,
      downTimeSec: (row.down_cycle_sec as number) ?? null,
      resultStatus: (row.result_status as string) ?? null,
      reportPath: (row.report_path as string) ?? null,
      results: row.results_json ? (JSON.parse(row.results_json as string) as TestResults) : null
    }
  }
}
