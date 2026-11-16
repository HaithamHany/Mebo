/**
 * MeBo's local medical database: SQLite through Node's built-in `node:sqlite`
 * (Node 22.13+), so there is no native module to build and no dependency to
 * add.
 *
 * Nothing in here knows about any language model. It stores and returns data;
 * the analytics are in analytics.mjs and the access surface in service.mjs.
 *
 * Tables
 *   meta          key/value provenance: schema and generator versions, seed,
 *                 dataset checksum, the scenario parameters as JSON
 *   sources       measurement sources, each flagged simulated or real
 *   missions      mission context
 *   astronauts    crew profiles, each flagged synthetic or real
 *   metrics       the indicator catalogue (name, unit, decimals)
 *   observations  every timestamped measurement — the history
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { METRICS, SOURCES } from './catalog.mjs'
import { GENERATOR_VERSION, SCENARIO, generate, scenarioNow } from './scenario.mjs'

export const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('synthetic', 'device', 'manual')),
  is_simulated INTEGER NOT NULL CHECK (is_simulated IN (0, 1)),
  description  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS missions (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  destination          TEXT,
  launch_at            TEXT NOT NULL,
  scenario_now         TEXT NOT NULL,
  preflight_days       INTEGER NOT NULL,
  inflight_days        INTEGER NOT NULL,
  planned_transit_days INTEGER,
  is_simulated         INTEGER NOT NULL CHECK (is_simulated IN (0, 1)),
  description          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS astronauts (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL REFERENCES missions(id),
  callsign      TEXT NOT NULL,
  role          TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  is_synthetic  INTEGER NOT NULL CHECK (is_synthetic IN (0, 1)),
  profile_notes TEXT NOT NULL,
  sort_order    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL,
  decimals    INTEGER NOT NULL,
  category    TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id           INTEGER PRIMARY KEY,
  astronaut_id TEXT NOT NULL REFERENCES astronauts(id),
  metric_code  TEXT NOT NULL REFERENCES metrics(code),
  value        REAL NOT NULL,
  unit         TEXT NOT NULL,
  observed_at  TEXT NOT NULL,
  mission_day  INTEGER NOT NULL,
  phase        TEXT NOT NULL CHECK (phase IN ('preflight', 'inflight')),
  source_id    TEXT NOT NULL REFERENCES sources(id),
  is_simulated INTEGER NOT NULL CHECK (is_simulated IN (0, 1)),
  session      TEXT
);
CREATE INDEX IF NOT EXISTS observations_series
  ON observations (astronaut_id, metric_code, observed_at);

-- A stored value must carry its metric's unit. Catching a unit mix-up at
-- write time is far cheaper than finding mmHg averaged with kPa later.
CREATE TRIGGER IF NOT EXISTS observations_unit_check
BEFORE INSERT ON observations
WHEN NEW.unit IS NOT (SELECT unit FROM metrics WHERE code = NEW.metric_code)
BEGIN
  SELECT RAISE(ABORT, 'observation unit does not match the metric catalogue');
END;

-- A row from a simulated source can never be marked as real.
CREATE TRIGGER IF NOT EXISTS observations_simulated_check
BEFORE INSERT ON observations
WHEN (SELECT is_simulated FROM sources WHERE id = NEW.source_id) = 1 AND NEW.is_simulated = 0
BEGIN
  SELECT RAISE(ABORT, 'a simulated source cannot produce a real observation');
END;
`

/** Open (creating if needed) the database at `path`, or ':memory:'. */
export async function openDatabase(path) {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new Error(
      `MeBo's medical database needs Node 22.13 or newer (node:sqlite); this is Node ${process.versions.node}.`,
    )
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  return db
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  )
}

export function getMeta(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]))
}

/** SHA-256 over the synthetic observations in canonical order. */
export function datasetChecksum(db) {
  const h = createHash('sha256')
  const rows = db
    .prepare(
      `SELECT astronaut_id, metric_code, value, unit, observed_at, mission_day, phase, source_id, is_simulated, session
       FROM observations WHERE is_simulated = 1
       ORDER BY astronaut_id, metric_code, observed_at, session`,
    )
    .all()
  for (const r of rows) h.update(JSON.stringify(Object.values(r)) + '\n')
  return h.digest('hex')
}

export function isSeeded(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM missions').get().n > 0
}

/**
 * Write the synthetic scenario. Replaces only simulated data: any real
 * observations recorded later are kept. One transaction, so a failure leaves
 * the previous dataset intact.
 */
export function seed(db, scenario = SCENARIO) {
  const rows = generate(scenario)
  const m = scenario.mission
  db.exec('BEGIN')
  try {
    db.exec('DELETE FROM observations WHERE is_simulated = 1')

    const src = db.prepare(
      `INSERT INTO sources (id, name, kind, is_simulated, description) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind,
         is_simulated = excluded.is_simulated, description = excluded.description`,
    )
    for (const s of SOURCES) src.run(s.id, s.name, s.kind, s.is_simulated, s.description)

    const met = db.prepare(
      `INSERT INTO metrics (code, name, unit, decimals, category, description) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, unit = excluded.unit,
         decimals = excluded.decimals, category = excluded.category, description = excluded.description`,
    )
    for (const x of METRICS) met.run(x.code, x.name, x.unit, x.decimals, x.category, x.description)

    db.prepare(
      `INSERT INTO missions (id, name, destination, launch_at, scenario_now, preflight_days, inflight_days,
         planned_transit_days, is_simulated, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, destination = excluded.destination,
         launch_at = excluded.launch_at, scenario_now = excluded.scenario_now,
         preflight_days = excluded.preflight_days, inflight_days = excluded.inflight_days,
         planned_transit_days = excluded.planned_transit_days, description = excluded.description`,
    ).run(m.id, m.name, m.destination, m.launch_at, scenarioNow(scenario), m.preflight_days, m.inflight_days,
      m.planned_transit_days, m.description)

    const crew = db.prepare(
      `INSERT INTO astronauts (id, mission_id, callsign, role, display_name, is_synthetic, profile_notes, sort_order)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET mission_id = excluded.mission_id, callsign = excluded.callsign,
         role = excluded.role, display_name = excluded.display_name, profile_notes = excluded.profile_notes,
         sort_order = excluded.sort_order`,
    )
    scenario.crew.forEach((c, i) => crew.run(c.id, m.id, c.callsign, c.role, c.display_name, c.profile_notes, i))

    const obs = db.prepare(
      `INSERT INTO observations (astronaut_id, metric_code, value, unit, observed_at, mission_day, phase,
         source_id, is_simulated, session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of rows) {
      obs.run(r.astronaut_id, r.metric_code, r.value, r.unit, r.observed_at, r.mission_day, r.phase,
        r.source_id, r.is_simulated, r.session)
    }

    setMeta(db, 'schema_version', SCHEMA_VERSION)
    setMeta(db, 'generator_version', GENERATOR_VERSION)
    setMeta(db, 'scenario_id', scenario.id)
    setMeta(db, 'seed', scenario.seed)
    setMeta(db, 'scenario_json', JSON.stringify(scenario))
    setMeta(db, 'observation_count', rows.length)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  // Outside the transaction so it reads exactly what was committed.
  setMeta(db, 'dataset_sha256', datasetChecksum(db))
  return rows.length
}
