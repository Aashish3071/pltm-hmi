import { join } from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { MIGRATIONS } from './schema'
import { DEFAULT_CONNECTION, DEFAULT_REGISTER_MAP } from '../hardware/config'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised — call initDb() first')
  return db
}

export function initDb(): Database.Database {
  const file = join(app.getPath('userData'), 'pltm.db')
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seed(db)
  // No run can be in progress at startup; anything still open was cut short by
  // a crash or power loss.
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
  load_capacity_n: '250',
  height_capacity_mm: '4000',
  machine_id: 'PLTM-0001',
  report_output_dir: '',
  hardware_driver: 'simulator',
  modbus_connection: JSON.stringify(DEFAULT_CONNECTION),
  modbus_register_map: JSON.stringify(DEFAULT_REGISTER_MAP, null, 2),
  company_name: 'Novatek',
  company_address: '',
  calibration_enforcement: 'warn',
  calibration_interval_months: '12',
  calibration_mpe_n: '1',
  certificate_seq: '0'
}

/**
 * Model profiles are (load, height) control points read top-to-bottom as the
 * pantograph rises then falls, tracing the closed load-vs-height envelope from
 * the manual. Row 4's height is the travel distance.
 */
const DEFAULT_MODELS: { name: string; distance: number; points: [number, number][] }[] = [
  {
    name: 'PANTO 3.8',
    distance: 3800,
    points: [
      [55, 150],
      [60, 860],
      [60, 3000],
      [55, 3800],
      [85, 3800],
      [80, 3000],
      [80, 860],
      [85, 150],
      [55, 150]
    ]
  },
  {
    name: 'HIGH SPEED BELLOW',
    distance: 3300,
    points: [
      [60, 150],
      [65, 800],
      [65, 2600],
      [60, 3300],
      [90, 3300],
      [85, 2600],
      [85, 800],
      [90, 150],
      [60, 150]
    ]
  },
  {
    name: 'RE140L',
    distance: 2900,
    points: [
      [50, 140],
      [55, 700],
      [55, 2300],
      [50, 2900],
      [78, 2900],
      [74, 2300],
      [74, 700],
      [78, 140],
      [50, 140]
    ]
  },
  {
    name: 'RE140E',
    distance: 2900,
    points: [
      [52, 140],
      [57, 700],
      [57, 2300],
      [52, 2900],
      [80, 2900],
      [76, 2300],
      [76, 700],
      [80, 140],
      [52, 140]
    ]
  },
  {
    name: 'RE260',
    distance: 2600,
    points: [
      [48, 130],
      [53, 650],
      [53, 2100],
      [48, 2600],
      [75, 2600],
      [71, 2100],
      [71, 650],
      [75, 130],
      [48, 130]
    ]
  }
]

const DEFAULT_USERS: { slot: string; role: 'admin' | 'operator'; password: string }[] = [
  { slot: 'ADMIN', role: 'admin', password: 'admin' },
  { slot: 'OPERATOR1', role: 'operator', password: 'operator1' },
  { slot: 'OPERATOR2', role: 'operator', password: 'operator2' },
  { slot: 'OPERATOR3', role: 'operator', password: 'operator3' }
]

function seed(database: Database.Database): void {
  const insertSetting = database.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  )
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value)

  const userCount = database.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
  if (userCount.n === 0) {
    const insertUser = database.prepare(
      'INSERT INTO users (slot, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
    )
    for (const u of DEFAULT_USERS) {
      insertUser.run(u.slot, u.slot, bcrypt.hashSync(u.password, 10), u.role)
    }
  }

  const modelCount = database.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }
  if (modelCount.n === 0) {
    const insertModel = database.prepare('INSERT INTO models (name, distance_mm) VALUES (?, ?)')
    const insertPoint = database.prepare(
      'INSERT INTO model_points (model_id, row_index, load_n, height_mm) VALUES (?, ?, ?, ?)'
    )
    const seedModels = database.transaction(() => {
      for (const m of DEFAULT_MODELS) {
        const { lastInsertRowid } = insertModel.run(m.name, m.distance)
        m.points.forEach(([load, height], i) => {
          insertPoint.run(lastInsertRowid, i + 1, load, height)
        })
      }
    })
    seedModels()
  }
}
