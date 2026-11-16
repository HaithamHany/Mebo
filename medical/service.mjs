/**
 * The medical data service — the one access surface over MeBo's health data.
 *
 * LLM-independent by design: the Claude bridge, the CLI, a future offline
 * model running through Ollama, and the tests all call these same functions.
 * Nothing here imports or assumes any language model, and every result is
 * plain JSON.
 *
 * Every response carries `simulated` and `notice`, so synthetic data cannot
 * reach any consumer without its label attached.
 */

import { fileURLToPath } from 'node:url'
import { METRIC, METRICS } from './catalog.mjs'
import { REFERENCES } from './references.mjs'
import { SCENARIO } from './scenario.mjs'
import { openDatabase, getMeta, isSeeded, seed } from './db.mjs'
import { baseline, deviation, latest, total, trend } from './analytics.mjs'

export const NOTICE =
  'SYNTHETIC DEMONSTRATION DATA. Fictional astronauts and a fictional mission, generated from a ' +
  'documented scenario. These are not real astronaut measurements, and no value here is a diagnosis.'

export const DEFAULT_DB_PATH =
  process.env.MEBO_MEDICAL_DB ?? fileURLToPath(new URL('../data/medical/mebo-medical.sqlite', import.meta.url))

export class MedicalError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * @param {{ path?: string, autoSeed?: boolean, memoryDir?: string, onMemorySave?: (id: string, json: string) => void, clock?: () => number }} [opts]
 *   path: database file, or ':memory:'. autoSeed: write the synthetic
 *   scenario if the database is empty (default true). memoryDir and clock are
 *   carried for the conversational memory (medical/memory), which is created
 *   on first use by the tools layer; the service itself never reads it.
 */
export async function createMedicalService({ path = DEFAULT_DB_PATH, autoSeed = true, memoryDir, onMemorySave, clock = Date.now } = {}) {
  const db = await openDatabase(path)
  if (autoSeed && !isSeeded(db)) seed(db, SCENARIO)

  const missionRow = () => db.prepare('SELECT * FROM missions ORDER BY id LIMIT 1').get()

  const stamp = (body) => {
    const m = missionRow()
    return {
      simulated: Boolean(m?.is_simulated ?? 1),
      notice: NOTICE,
      ...body,
    }
  }

  const astronaut = (id) => {
    const a = db.prepare('SELECT * FROM astronauts WHERE id = ?').get(id)
    if (!a) throw new MedicalError(404, `No astronaut "${id}".`)
    return a
  }

  const metricOf = (code) => {
    const m = METRIC[code]
    if (!m) throw new MedicalError(400, `Unknown metric "${code}". Known: ${METRICS.map((x) => x.code).join(', ')}.`)
    return m
  }

  const points = (id, code) => {
    const now = missionRow().scenario_now
    return db
      .prepare(
        `SELECT id, value, unit, observed_at, mission_day, phase, source_id, is_simulated, session
         FROM observations WHERE astronaut_id = ? AND metric_code = ? AND observed_at <= ?
         ORDER BY observed_at`,
      )
      .all(id, code, now)
  }

  const missionView = () => {
    const m = missionRow()
    const crew = db.prepare('SELECT COUNT(*) AS n FROM astronauts WHERE mission_id = ?').get(m.id).n
    return {
      id: m.id,
      name: m.name,
      destination: m.destination,
      launch_at: m.launch_at,
      scenario_now: m.scenario_now,
      preflight_days: m.preflight_days,
      inflight_days: m.inflight_days,
      planned_transit_days: m.planned_transit_days,
      is_simulated: m.is_simulated === 1,
      description: m.description,
      crew_count: crew,
    }
  }

  const profile = (a) => ({
    id: a.id,
    callsign: a.callsign,
    role: a.role,
    display_name: a.display_name,
    is_synthetic: a.is_synthetic === 1,
    profile_notes: a.profile_notes,
  })

  const staleAfter = () => Number(JSON.parse(getMeta(db).scenario_json ?? '{}').stale_after_hours ?? SCENARIO.stale_after_hours)

  /** Window of the last `days` mission days, ending on the last simulated day. */
  const windowOf = (days) => {
    const last = missionRow().inflight_days
    let from = last - Math.max(1, Math.floor(days)) + 1
    if (from <= 0) from -= 1 // mission day 0 does not exist
    return [from, last]
  }

  const metricSummary = (id, m) => {
    const pts = points(id, m.code)
    const now = missionRow().scenario_now
    const cur = latest(pts, now, staleAfter())
    const base = m.baseline === false ? null : baseline(pts, m.decimals)
    const out = {
      metric: m.code,
      name: m.name,
      unit: m.unit,
      latest: cur,
      baseline: base,
      deviation: deviation(cur, base, m.decimals),
    }
    if (m.code === 'radiation_dose') {
      const inflight = pts.filter((p) => p.phase === 'inflight')
      out.cumulative = { value: Math.round(total(inflight) * 1000) / 1000, unit: m.unit, days: inflight.length }
    }
    return out
  }

  return {
    memoryDir,
    onMemorySave,
    clock,

    /** Dataset provenance: versions, seed, checksum, scenario and references. */
    provenance() {
      const meta = getMeta(db)
      return stamp({
        schema_version: Number(meta.schema_version),
        generator_version: Number(meta.generator_version),
        scenario_id: meta.scenario_id,
        seed: Number(meta.seed),
        dataset_sha256: meta.dataset_sha256,
        observation_count: Number(meta.observation_count),
        scenario: meta.scenario_json ? JSON.parse(meta.scenario_json) : null,
        references: REFERENCES,
      })
    },

    mission() {
      return stamp({ mission: missionView() })
    },

    crew() {
      const rows = db.prepare('SELECT * FROM astronauts ORDER BY sort_order').all()
      return stamp({ crew: rows.map(profile) })
    },

    /** The indicator catalogue, with units and NASA risk mapping. */
    metrics() {
      return stamp({ metrics: METRICS, references: REFERENCES })
    },

    /** Latest values, baselines and deviations for every metric. */
    summary(id) {
      const a = astronaut(id)
      return stamp({
        astronaut: profile(a),
        scenario_now: missionRow().scenario_now,
        stale_after_hours: staleAfter(),
        metrics: Object.fromEntries(METRICS.map((m) => [m.code, metricSummary(a.id, m)])),
      })
    },

    /** Raw timestamped observations, optionally limited to the last `days`. */
    history(id, code, { days } = {}) {
      const a = astronaut(id)
      const m = metricOf(code)
      let pts = points(a.id, m.code)
      let window = null
      if (days !== undefined) {
        window = windowOf(days)
        pts = pts.filter((p) => p.mission_day >= window[0] && p.mission_day <= window[1])
      }
      return stamp({
        astronaut_id: a.id,
        metric: m.code,
        unit: m.unit,
        window: window && { from_day: window[0], to_day: window[1] },
        observations: pts.map((p) => ({ ...p, is_simulated: p.is_simulated === 1 })),
      })
    },

    /** Daily means, slope, coverage and missing days over the last `days`. */
    trend(id, code, { days = 30 } = {}) {
      const a = astronaut(id)
      const m = metricOf(code)
      const [from, to] = windowOf(days)
      return stamp({ astronaut_id: a.id, metric: m.code, unit: m.unit, trend: trend(points(a.id, m.code), from, to, m.decimals) })
    },

    /** Everything the crew dashboard draws, in one call. */
    dashboard({ trendDays = 30, trendMetric = 'heart_rate' } = {}) {
      const rows = db.prepare('SELECT * FROM astronauts ORDER BY sort_order').all()
      const m = metricOf(trendMetric)
      const [from, to] = windowOf(trendDays)
      return stamp({
        mission: missionView(),
        scenario_now: missionRow().scenario_now,
        crew: rows.map((a) => ({
          ...profile(a),
          metrics: Object.fromEntries(METRICS.map((x) => [x.code, metricSummary(a.id, x)])),
          trend: { metric: m.code, unit: m.unit, ...trend(points(a.id, m.code), from, to, m.decimals) },
        })),
      })
    },

    /**
     * Record one observation. Not exposed over HTTP: the read-only API is all
     * a model or a page may reach. For future device integration and tests.
     */
    record({ astronaut_id, metric_code, value, observed_at, mission_day, source_id, session = null }) {
      const a = astronaut(astronaut_id)
      const m = metricOf(metric_code)
      const src = db.prepare('SELECT * FROM sources WHERE id = ?').get(source_id)
      if (!src) throw new MedicalError(400, `Unknown source "${source_id}".`)
      if (!Number.isFinite(value)) throw new MedicalError(400, 'value must be a finite number')
      db.prepare(
        `INSERT INTO observations (astronaut_id, metric_code, value, unit, observed_at, mission_day, phase,
           source_id, is_simulated, session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.id, m.code, value, m.unit, new Date(observed_at).toISOString(), mission_day,
        mission_day < 1 ? 'preflight' : 'inflight', src.id, src.is_simulated, session)
    },

    /** Regenerate the synthetic dataset (simulated rows only). */
    reseed() {
      return seed(db, SCENARIO)
    },

    close() {
      db.close()
    },
  }
}
