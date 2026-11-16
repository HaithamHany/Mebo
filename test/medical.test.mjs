// MeBo's medical data foundation: database, synthetic scenario, analytics,
// and the read-only API — including through the real bridge process.
//
//   node --test test/
//
// Nothing here talks to any language model.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METRIC, METRICS, SOURCES } from '../medical/catalog.mjs'
import { REFERENCES } from '../medical/references.mjs'
import { SCENARIO, generate } from '../medical/scenario.mjs'
import { datasetChecksum, getMeta, openDatabase, seed } from '../medical/db.mjs'
import { createMedicalService, MedicalError, NOTICE } from '../medical/service.mjs'
import { route } from '../medical/http.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'mebo-medical-'))
const memory = () => createMedicalService({ path: ':memory:' })

// --- determinism ------------------------------------------------------------

test('the synthetic dataset is deterministic and reproducible', async () => {
  assert.deepEqual(generate(), generate(), 'two generations differ')
  const a = await openDatabase(':memory:')
  const b = await openDatabase(':memory:')
  seed(a)
  seed(b)
  assert.equal(datasetChecksum(a), datasetChecksum(b))
  assert.equal(getMeta(a).dataset_sha256, datasetChecksum(a), 'stored checksum matches the data')
  // A different seed gives different data: the seed is genuinely in charge.
  const c = await openDatabase(':memory:')
  seed(c, { ...SCENARIO, seed: SCENARIO.seed + 1 })
  assert.notEqual(datasetChecksum(c), datasetChecksum(a))
  // The checksum published in the docs is the one this machine produces.
  const doc = readFileSync(fileURLToPath(new URL('../docs/medical-data.md', import.meta.url)), 'utf8')
  const published = /dataset SHA-256\s*`([0-9a-f]{64})`/.exec(doc)?.[1]
  assert.equal(published, datasetChecksum(a), 'docs/medical-data.md checksum is out of date')
  assert.equal(Number(getMeta(a).observation_count), 8022)
  for (const db of [a, b, c]) db.close()
})

test('the generator uses no ambient randomness or clock', () => {
  const src = readFileSync(fileURLToPath(new URL('../medical/scenario.mjs', import.meta.url)), 'utf8')
  assert.doesNotMatch(src, /Math\.random\(|Date\.now\(|new Date\(\)/)
})

// --- persistence ------------------------------------------------------------

test('the database persists across close and reopen, and reopening does not reseed', async () => {
  const dir = tmp()
  const path = join(dir, 'mebo.sqlite')
  try {
    let s = await createMedicalService({ path })
    const before = s.provenance()
    s.record({
      astronaut_id: 'cdr', metric_code: 'heart_rate', value: 61,
      observed_at: '2033-08-17T22:00:00.000Z', mission_day: 120, source_id: 'synthetic-wearable', session: 'test',
    })
    s.close()

    s = await createMedicalService({ path })
    const after = s.provenance()
    assert.equal(after.dataset_sha256, before.dataset_sha256)
    const hist = s.history('cdr', 'heart_rate').observations
    assert.ok(hist.some((o) => o.session === 'test' && o.value === 61), 'recorded observation survived reopen')
    assert.equal(s.summary('cdr').metrics.heart_rate.latest.value, 61, 'and is now the latest reading')
    s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- units ------------------------------------------------------------------

test('every observation carries its metric unit, at its declared precision', async () => {
  const db = await openDatabase(':memory:')
  seed(db)
  const bad = db.prepare('SELECT COUNT(*) AS n FROM observations o JOIN metrics m ON m.code = o.metric_code WHERE o.unit <> m.unit').get().n
  assert.equal(bad, 0)
  for (const m of METRICS) {
    const rows = db.prepare('SELECT value FROM observations WHERE metric_code = ?').all(m.code)
    assert.ok(rows.length > 0, `${m.code} has data`)
    for (const { value } of rows) {
      assert.equal(Math.round(value * 10 ** m.decimals) / 10 ** m.decimals, value, `${m.code} ${value} exceeds ${m.decimals} decimals`)
    }
  }
  const expected = { heart_rate: 'bpm', bp_systolic: 'mmHg', bp_diastolic: 'mmHg', spo2: '%', respiratory_rate: 'breaths/min',
    body_temperature: '°C', sleep_duration: 'h', mood: 'score (1–5)', activity: 'min', radiation_dose: 'mSv' }
  for (const [code, unit] of Object.entries(expected)) assert.equal(METRIC[code].unit, unit)
  db.close()
})

test('the database refuses an observation in the wrong unit', async () => {
  const db = await openDatabase(':memory:')
  seed(db)
  assert.throws(
    () => db.prepare(`INSERT INTO observations (astronaut_id, metric_code, value, unit, observed_at, mission_day, phase, source_id, is_simulated)
      VALUES ('cdr', 'bp_systolic', 16, 'kPa', '2033-08-17T07:00:00Z', 120, 'inflight', 'synthetic-bp-cuff', 1)`).run(),
    /unit does not match/,
  )
  db.close()
})

test('values stay physically plausible', async () => {
  const rows = generate()
  for (const r of rows) {
    if (r.metric_code === 'spo2') assert.ok(r.value <= 100)
    if (r.metric_code === 'mood') assert.ok(r.value >= 1 && r.value <= 5)
    if (['sleep_duration', 'activity', 'radiation_dose'].includes(r.metric_code)) assert.ok(r.value >= 0)
  }
})

// --- simulation labelling ---------------------------------------------------

test('everything synthetic is labelled synthetic, at every layer', async () => {
  const db = await openDatabase(':memory:')
  seed(db)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations WHERE is_simulated <> 1').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM astronauts WHERE is_synthetic <> 1').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM missions WHERE is_simulated <> 1').get().n, 0)
  assert.ok(SOURCES.every((s) => s.is_simulated === 1 && s.kind === 'synthetic'))
  assert.ok(db.prepare('SELECT display_name FROM astronauts').all().every((a) => /fictional/i.test(a.display_name)))
  // A simulated source cannot be passed off as real.
  assert.throws(
    () => db.prepare(`INSERT INTO observations (astronaut_id, metric_code, value, unit, observed_at, mission_day, phase, source_id, is_simulated)
      VALUES ('cdr', 'heart_rate', 60, 'bpm', '2033-08-17T07:00:00Z', 120, 'inflight', 'synthetic-wearable', 0)`).run(),
    /simulated source/,
  )
  db.close()

  const s = await memory()
  const responses = [
    s.provenance(), s.mission(), s.crew(), s.metrics(), s.summary('cdr'),
    s.history('cdr', 'heart_rate', { days: 7 }), s.trend('cdr', 'heart_rate'), s.dashboard(),
  ]
  for (const r of responses) {
    assert.equal(r.simulated, true)
    assert.equal(r.notice, NOTICE)
    assert.match(r.notice, /not real astronaut measurements/)
  }
  assert.ok(s.history('cdr', 'heart_rate').observations.every((o) => o.is_simulated === true))
  s.close()
})

// --- baselines --------------------------------------------------------------

test('individual baselines come from pre-flight data and match the scenario', async () => {
  const s = await memory()
  for (const crew of SCENARIO.crew) {
    const hr = s.summary(crew.id).metrics.heart_rate.baseline
    assert.equal(hr.method, 'preflight')
    // Morning + evening for every pre-flight day — less Okafor's skipped
    // evening checks, a documented gap pattern that applies on the ground too.
    const full = SCENARIO.mission.preflight_days * 2
    if (crew.id === 'plt') assert.ok(hr.n < full && hr.n >= full * 0.85, `plt n=${hr.n}`)
    else assert.equal(hr.n, full)
    // Mean of morning (base) and evening (base + offset) readings.
    const expected = crew.base.heart_rate + SCENARIO.metrics.heart_rate.evening_offset / 2
    assert.ok(Math.abs(hr.mean - expected) < 2, `${crew.id} baseline ${hr.mean} vs ${expected}`)
    assert.ok(hr.sd > 0)
  }
  // Radiation is exposure, not physiology: no baseline, a cumulative total instead.
  const rad = s.summary('cdr').metrics.radiation_dose
  assert.equal(rad.baseline, null)
  assert.equal(rad.deviation, null)
  s.close()
})

test('deviation is reported against the person, not a population threshold', async () => {
  const s = await memory()
  const novak = s.summary('ms2').metrics.sleep_duration
  assert.ok(novak.deviation.z < -2, `storyline should make Novak's sleep unusual for Novak (z=${novak.deviation.z})`)
  assert.equal(novak.deviation.baseline_method, 'preflight')
  // Nothing in the data is a clinical label. (The notice is excluded: it
  // says, deliberately, that nothing here is a diagnosis.)
  const text = JSON.stringify(s.summary('ms2').metrics)
  assert.doesNotMatch(text, /abnormal|normal range|diagnos(is|e)|tachycardia|hypertension|treatment/i)
  s.close()
})

// --- historical trends ------------------------------------------------------

test('historical trends reflect the documented scenario', async () => {
  const s = await memory()
  // Novak's sleep falls from day 45 (storyline); Reyes' does not.
  const novak = s.trend('ms2', 'sleep_duration', { days: 76 }).trend // days 45–120
  const reyes = s.trend('cdr', 'sleep_duration', { days: 76 }).trend
  assert.ok(novak.slope_per_week < -0.05, `Novak sleep slope ${novak.slope_per_week}`)
  assert.ok(Math.abs(reyes.slope_per_week) < 0.05, `Reyes sleep slope ${reyes.slope_per_week}`)

  // Cumulative dose ≈ 1.84 mSv/day × days × dose factor, plus the event day.
  for (const crew of SCENARIO.crew) {
    const cum = s.summary(crew.id).metrics.radiation_dose.cumulative
    const ev = SCENARIO.events[0]
    const expected = SCENARIO.metrics.radiation_dose.daily_mean * crew.dose_factor * (SCENARIO.mission.inflight_days - 1 + ev.multiplier)
    assert.ok(Math.abs(cum.value - expected) / expected < 0.03, `${crew.id} cumulative ${cum.value} vs ${expected}`)
    assert.equal(cum.unit, 'mSv')
  }

  // Trend windows reaching back into pre-flight skip the non-existent day 0.
  const long = s.trend('cdr', 'heart_rate', { days: 125 }).trend
  assert.ok(!long.missing_days.includes(0))
  assert.equal(long.days_in_window, 125)
  s.close()
})

// --- crew selection ---------------------------------------------------------

test('each crew member is selectable and returns their own data', async () => {
  const s = await memory()
  const ids = s.crew().crew.map((c) => c.id)
  assert.deepEqual(ids, ['cdr', 'plt', 'ms1', 'ms2'])
  const baselines = new Set()
  for (const id of ids) {
    const sum = s.summary(id)
    assert.equal(sum.astronaut.id, id)
    baselines.add(sum.metrics.heart_rate.baseline.mean)
  }
  assert.equal(baselines.size, 4, 'four people, four different baselines')
  assert.throws(() => s.summary('nobody'), (e) => e instanceof MedicalError && e.status === 404)
  assert.throws(() => s.trend('cdr', 'iq'), (e) => e instanceof MedicalError && e.status === 400)
  s.close()
})

// --- missing data -----------------------------------------------------------

test('missing data is reported as missing, never filled in', async () => {
  const s = await memory()
  // Chen's wearable is offline for days 61–67 and 118–120.
  const t = s.trend('ms1', 'heart_rate', { days: 70 }).trend
  for (const d of [61, 62, 63, 64, 65, 66, 67, 118, 119, 120]) assert.ok(t.missing_days.includes(d), `day ${d} missing`)
  assert.ok(t.coverage < 1)
  const hr = s.summary('ms1').metrics.heart_rate
  assert.equal(hr.latest.mission_day, 117)
  assert.equal(hr.latest.stale, true, 'the last reading is three days old')
  assert.equal(hr.deviation, null, 'no deviation without a current reading')
  // Actigraphy is a different device and keeps recording.
  assert.equal(s.summary('ms1').metrics.sleep_duration.latest.stale, false)

  // Okafor skips some evening checks: fewer readings than sessions.
  const ok = s.history('plt', 'heart_rate').observations
  const sessions = (SCENARIO.mission.preflight_days + SCENARIO.mission.inflight_days) * 2
  assert.ok(ok.length < sessions && ok.length > sessions * 0.9, `${ok.length} of ${sessions}`)

  // No dosimeter before flight: pre-flight dose history is empty, not zero.
  const rad = s.history('cdr', 'radiation_dose').observations
  assert.ok(rad.every((o) => o.phase === 'inflight'))
  s.close()
})

// --- documentation ------------------------------------------------------------

test('every scenario parameter is documented with a basis and real references', () => {
  const bases = new Set(['literature', 'literature-direction', 'illustrative'])
  const items = [...Object.values(SCENARIO.metrics), ...SCENARIO.events, ...SCENARIO.storylines]
  for (const p of items) {
    assert.ok(bases.has(p.basis), `basis ${p.basis}`)
    assert.ok(p.note && p.note.length > 10)
    for (const r of p.refs) assert.ok(REFERENCES[r], `unknown reference ${r}`)
  }
  for (const m of METRICS) for (const r of m.refs) assert.ok(REFERENCES[r], `${m.code} cites unknown ${r}`)
  const doc = readFileSync(fileURLToPath(new URL('../docs/medical-data.md', import.meta.url)), 'utf8')
  for (const m of METRICS) assert.ok(doc.includes(m.code), `docs mention ${m.code}`)
  for (const r of Object.values(REFERENCES)) assert.ok(doc.includes(r.url), `docs cite ${r.url}`)
})

// --- the API ------------------------------------------------------------------

test('the API routes are read-only and validate their input', async () => {
  const s = await memory()
  assert.equal(route(s, 'GET', '/medical/crew/ms2').astronaut.id, 'ms2')
  assert.equal(route(s, 'GET', '/medical/crew/cdr/trend?metric=spo2&days=7').trend.days_in_window, 7)
  assert.equal(route(s, 'GET', '/medical/dashboard').crew.length, 4)
  assert.throws(() => route(s, 'POST', '/medical/crew'), (e) => e.status === 405)
  assert.throws(() => route(s, 'GET', '/medical/crew/cdr/trend?metric=spo2&days=-3'), (e) => e.status === 400)
  assert.throws(() => route(s, 'GET', '/medical/nothing'), (e) => e.status === 404)
  s.close()
})

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))

function startBridge(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MEBO_BRIDGE_PORT: '0', MEBO_MEMORY_DIR: mkdtempSync(join(tmpdir(), 'mebo-med-mem-')), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (child.kill(), reject(new Error(`bridge did not start: ${log}`))), 15_000)
    child.stdout.on('data', (d) => {
      log += d
      const m = /bridge listening on ws:\/\/(\S+):(\d+)/.exec(log)
      if (m) {
        clearTimeout(timer)
        resolve({ child, port: Number(m[2]) })
      }
    })
    child.stderr.on('data', (d) => (log += d))
    child.on('exit', (code) => reject(new Error(`bridge exited ${code}: ${log}`)))
  })
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers, timeout: 10_000 }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

test('the bridge serves the medical API, behind its existing origin checks', async () => {
  const dir = tmp()
  const bridge = await startBridge({ MEBO_MEDICAL_DB: join(dir, 'bridge.sqlite') })
  try {
    const page = { origin: 'http://localhost:5173' }
    const crew = await get(bridge.port, '/medical/crew', page)
    assert.equal(crew.status, 200)
    assert.equal(crew.headers['access-control-allow-origin'], 'http://localhost:5173')
    const body = JSON.parse(crew.body)
    assert.equal(body.simulated, true)
    assert.equal(body.crew.length, 4)

    const dash = JSON.parse((await get(bridge.port, '/medical/dashboard', page)).body)
    assert.equal(dash.crew[2].metrics.heart_rate.latest.stale, true)

    assert.equal((await get(bridge.port, '/medical/crew', { origin: 'https://evil.example' })).status, 403)
    assert.equal((await get(bridge.port, '/medical/crew/nobody', page)).status, 404)
  } finally {
    // Wait for exit: on Windows the database file stays locked until it does.
    const gone = new Promise((r) => bridge.child.once('exit', r))
    bridge.child.kill()
    await gone
    rmSync(dir, { recursive: true, force: true })
  }
})
