import { join } from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { MIGRATIONS } from './schema'
import { DEFAULT_HARDWARE_CONFIG } from '../hardware/config'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised — call initDb() first')
  return db
}

export function initDb(file = join(app.getPath('userData'), 'pltm.db')): Database.Database {
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seed(db)
  // No test can be in progress at startup; anything still open was cut short
  // by a crash or power loss.
  db.prepare(
    "UPDATE test_runs SET ended_at = datetime('now'), result_status = 'ABORTED' WHERE ended_at IS NULL"
  ).run()
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

function migrate(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number
  for (let version = current; version < MIGRATIONS.length; version++) {
    database.transaction(() => {
      database.exec(MIGRATIONS[version])
      database.pragma(`user_version = ${version + 1}`)
    })()
  }
}

const DEFAULT_SETTINGS: Record<string, string> = {
  up_speed_mm_s: '50',
  down_speed_mm_s: '50',
  jog_speed_mm_s: '50',
  load_capacity_kg: '50',
  height_capacity_mm: '4000',
  machine_id: 'PLT-001',
  report_output_dir: '',
  hardware_config: JSON.stringify(DEFAULT_HARDWARE_CONFIG),
  company_name: '',
  company_address_1: '',
  company_address_2: '',
  measurement_speed_text: '',
  graph_history: '[]'
}

/**
 * Starter models: 9 heights rising to the travel distance and back, with the
 * reference loads. Edit or add models in Settings.
 */
const DEFAULT_MODELS: { name: string; heights: number[]; loads: number[] }[] = [
  {
    name: 'PANTO-3600',
    heights: [150, 840, 2910, 3600, 3600, 2910, 840, 150, 150],
    loads: [55, 60, 60, 55, 85, 80, 80, 85, 55]
  },
  {
    name: 'PANTO-3400',
    heights: [150, 700, 2700, 3400, 3400, 2700, 700, 150, 150],
    loads: [55, 60, 60, 55, 85, 80, 80, 85, 55]
  },
  {
    name: 'PANTO-2400',
    heights: [100, 560, 1940, 2400, 2400, 1940, 560, 100, 100],
    loads: [50, 55, 55, 50, 80, 75, 75, 80, 50]
  },
  {
    name: 'PANTO-1800',
    heights: [100, 440, 1460, 1800, 1800, 1460, 440, 100, 100],
    loads: [50, 55, 55, 50, 80, 75, 75, 80, 50]
  }
]

/** Four accounts; the first one is the administrator. */
const DEFAULT_USERS: { slot: string; role: 'admin' | 'operator'; password: string }[] = [
  { slot: 'ADMIN', role: 'admin', password: '1234' },
  { slot: 'OPERATOR1', role: 'operator', password: '123' },
  { slot: 'OPERATOR2', role: 'operator', password: '123' },
  { slot: 'OPERATOR3', role: 'operator', password: '123' }
]

function seed(database: Database.Database): void {
  const insertSetting = database.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value)

  const userCount = database.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  if (userCount.n === 0) {
    const insertUser = database.prepare(
      'INSERT INTO users (slot, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
    )
    for (const u of DEFAULT_USERS) insertUser.run(u.slot, u.slot, bcrypt.hashSync(u.password, 10), u.role)
  }

  const modelCount = database.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }
  if (modelCount.n === 0) {
    const insertModel = database.prepare('INSERT INTO models (name, distance_mm) VALUES (?, ?)')
    const insertPoint = database.prepare(
      'INSERT INTO model_points (model_id, row_index, load_n, height_mm) VALUES (?, ?, ?, ?)'
    )
    database.transaction(() => {
      for (const m of DEFAULT_MODELS) {
        const { lastInsertRowid } = insertModel.run(m.name, m.heights[3])
        m.heights.forEach((height, i) => insertPoint.run(lastInsertRowid, i + 1, m.loads[i], height))
      }
    })()
    database
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('current_model_id', String((database.prepare('SELECT MIN(id) AS id FROM models').get() as { id: number }).id))
  }
}
