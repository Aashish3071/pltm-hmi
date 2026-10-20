// Inlined rather than loaded from .sql files so they survive asar packaging.
// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
// Never edit a shipped migration — append a new one.
export const MIGRATIONS: string[] = [
  // v1 — initial schema. Uses IF NOT EXISTS so pre-migration installs adopt it.
  `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  slot TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  distance_mm REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_points (
  id INTEGER PRIMARY KEY,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  row_index INTEGER NOT NULL,
  load_n REAL NOT NULL,
  height_mm REAL NOT NULL,
  UNIQUE(model_id, row_index)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_runs (
  id INTEGER PRIMARY KEY,
  employee_user_id INTEGER REFERENCES users(id),
  model_id INTEGER REFERENCES models(id),
  part_no TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  up_cycle_sec REAL,
  down_cycle_sec REAL,
  max_load_n REAL,
  result_status TEXT,
  report_path TEXT
);

CREATE TABLE IF NOT EXISTS test_run_points (
  id INTEGER PRIMARY KEY,
  test_run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  t_ms INTEGER NOT NULL,
  load_n REAL NOT NULL,
  height_mm REAL NOT NULL,
  phase TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_test_run_points_run ON test_run_points(test_run_id);
`,
  // v2 — models are archived rather than deleted so past test runs keep their model.
  `ALTER TABLE models ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`
]
