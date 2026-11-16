/**
 * The synthetic Mars-transit scenario, and the deterministic generator that
 * turns it into observations.
 *
 * EVERYTHING HERE IS SYNTHETIC. Four fictional astronauts on a fictional
 * mission, generated from documented parameters. Nothing here is, or
 * resembles, a real astronaut's measurements.
 *
 * Every parameter records its `basis`:
 *   literature           — the magnitude comes from the cited reference
 *   literature-direction — the direction of change comes from the reference;
 *                          the magnitude is an illustrative assumption
 *   illustrative         — an assumption chosen to be plausible and visible in
 *                          a demonstration, not derived from flight data
 * and the reference ids (see references.mjs) behind it.
 *
 * Determinism: values come from a seeded PRNG (mulberry32), one independent
 * stream per astronaut and metric, drawn in a fixed order. The same
 * GENERATOR_VERSION and seed always produce byte-identical data, and the
 * dataset checksum stored with the database proves it.
 */

import { METRIC } from './catalog.mjs'

export const GENERATOR_VERSION = 1

export const SCENARIO = {
  id: 'mebo-mars-transit-demo',
  seed: 0x4d65426f, // "MeBo"
  mission: {
    id: 'mars-transit-demo',
    name: 'MeBo Demonstration — Mars Transit',
    destination: 'Mars',
    // A fictional future launch. Mission day 1 is the launch day.
    launch_at: '2033-04-20T00:00:00.000Z',
    preflight_days: 28,
    inflight_days: 120,
    planned_transit_days: 210,
    description:
      'Fictional crewed Mars transit used to demonstrate MeBo. 28 days of pre-flight ' +
      'baseline, then the first 120 days of an outbound transit. Synthetic data only.',
    basis: {
      planned_transit_days: {
        basis: 'illustrative',
        refs: ['S1'],
        note: 'S1 puts Mars ~140 million miles away and a round trip at roughly three years; a ~7-month outbound leg is assumed.',
      },
    },
  },
  /** Times of day (UTC) at which each kind of observation is recorded. */
  sessions: {
    morning: '07:00',
    evening: '19:00',
    bp: '07:15',
    sleep: '06:30',
    evening_report: '21:00',
    dosimeter: '23:59',
  },
  /** How old a latest reading may be, relative to scenario time, before it
   *  is reported as stale (not current) rather than as the current value. */
  stale_after_hours: 48,

  crew: [
    {
      id: 'cdr',
      callsign: 'REYES',
      role: 'CDR',
      display_name: 'Cmdr. A. Reyes (fictional)',
      profile_notes: 'Fictional commander. Nominal adaptation throughout.',
      base: { heart_rate: 62, bp_systolic: 118, bp_diastolic: 76, spo2: 98.2, respiratory_rate: 14, body_temperature: 36.7, sleep_duration: 7.3, mood: 4.1, activity: 50 },
      dose_factor: 1.0,
    },
    {
      id: 'plt',
      callsign: 'OKAFOR',
      role: 'PLT',
      display_name: 'Plt. K. Okafor (fictional)',
      profile_notes: 'Fictional pilot. Occasionally skips the evening wearable check (missing-data pattern).',
      base: { heart_rate: 68, bp_systolic: 122, bp_diastolic: 79, spo2: 97.9, respiratory_rate: 15, body_temperature: 36.8, sleep_duration: 7.1, mood: 3.9, activity: 45 },
      dose_factor: 1.03,
    },
    {
      id: 'ms1',
      callsign: 'CHEN',
      role: 'MS1',
      display_name: 'Dr. L. Chen (fictional)',
      profile_notes: 'Fictional mission specialist. Wearable offline for a week mid-mission and again at the end (missing-data pattern).',
      base: { heart_rate: 58, bp_systolic: 112, bp_diastolic: 72, spo2: 98.6, respiratory_rate: 13, body_temperature: 36.6, sleep_duration: 7.5, mood: 4.0, activity: 60 },
      dose_factor: 0.96,
    },
    {
      id: 'ms2',
      callsign: 'NOVAK',
      role: 'MS2',
      display_name: 'Eng. S. Novak (fictional)',
      profile_notes: 'Fictional mission specialist. Illustrative storyline of shortened sleep and lower mood from day 45.',
      base: { heart_rate: 66, bp_systolic: 120, bp_diastolic: 78, spo2: 98.1, respiratory_rate: 14, body_temperature: 36.7, sleep_duration: 7.2, mood: 4.0, activity: 50 },
      dose_factor: 1.01,
    },
  ],

  /**
   * Per-metric model, applied to every crew member:
   *   value = base + inflight change + time-of-day offset + noise (+ storyline)
   * `change` shapes: 'adapt' = A·(1 − e^(−day/τ)), 'level' = move to an
   * absolute in-flight level with time constant τ, 'drift' = linear A·day/N.
   */
  metrics: {
    heart_rate: {
      source: 'synthetic-wearable', sessions: ['morning', 'evening'], noise_sd: 3, evening_offset: 4,
      change: { shape: 'adapt', amplitude: -3, tau_days: 10 },
      basis: 'illustrative', refs: ['S2'],
      note: 'S2 names Risk of Cardiovascular Adaptations; the supplied sources give no heart-rate magnitude, so a small decrease is assumed.',
    },
    bp_systolic: {
      source: 'synthetic-bp-cuff', sessions: ['bp'], noise_sd: 5,
      change: { shape: 'adapt', amplitude: -6, tau_days: 7 },
      basis: 'literature-direction', refs: ['S2', 'E3'],
      note: 'E3 reports reduced ambulatory blood pressure in long-duration flight; the −6 mmHg magnitude is illustrative.',
    },
    bp_diastolic: {
      source: 'synthetic-bp-cuff', sessions: ['bp'], noise_sd: 4,
      change: { shape: 'adapt', amplitude: -4, tau_days: 7 },
      basis: 'literature-direction', refs: ['S2', 'E3'],
      note: 'As systolic; the −4 mmHg magnitude is illustrative.',
    },
    spo2: {
      source: 'synthetic-wearable', sessions: ['morning', 'evening'], noise_sd: 0.6, max: 100,
      change: { shape: 'adapt', amplitude: 0, tau_days: 1 },
      basis: 'illustrative', refs: ['S2'],
      note: 'No change assumed: a nominal cabin atmosphere. S2 names Risk of Hypoxia; no hypoxia event is simulated.',
    },
    respiratory_rate: {
      source: 'synthetic-wearable', sessions: ['morning', 'evening'], noise_sd: 1.1,
      change: { shape: 'adapt', amplitude: 0, tau_days: 1 },
      basis: 'illustrative', refs: [],
      note: 'No change assumed.',
    },
    body_temperature: {
      source: 'synthetic-wearable', sessions: ['morning', 'evening'], noise_sd: 0.12, evening_offset: 0.3,
      change: { shape: 'adapt', amplitude: 0.3, tau_days: 45 },
      basis: 'literature-direction', refs: ['E4'],
      note: 'E4 reports a gradual rise in core body temperature in long-duration flight; the +0.3 °C magnitude is illustrative and conservative.',
    },
    sleep_duration: {
      source: 'synthetic-actigraphy', sessions: ['sleep'], noise_sd: 0.45, min: 0,
      change: { shape: 'level', level: 6.0, personal_weight: 0.5, tau_days: 3 },
      basis: 'literature', refs: ['S2', 'S3', 'E2'],
      note: 'In-flight mean of ~6 h per night (E2), each person keeping half of their pre-flight difference from the crew mean.',
    },
    mood: {
      source: 'synthetic-self-report', sessions: ['evening_report'], noise_sd: 0.55, min: 1, max: 5,
      change: { shape: 'drift', amplitude: -0.3 },
      basis: 'illustrative', refs: ['S1', 'S2'],
      note: 'S1 names isolation and confinement as a hazard; a slight downward drift is assumed. Demonstration scale, not a validated instrument.',
    },
    activity: {
      source: 'synthetic-actigraphy', sessions: ['evening_report'], noise_sd: 12, min: 0,
      change: { shape: 'level', level: 100, personal_weight: 0.5, tau_days: 2 },
      basis: 'illustrative', refs: ['S2', 'S3'],
      note: 'Daily countermeasure exercise is assumed to rise to ~100 min in flight. S3 lists exercise research (Zero T2); the figure is illustrative.',
    },
    radiation_dose: {
      source: 'synthetic-dosimeter', sessions: ['dosimeter'], noise_sd: 0.08, min: 0, inflight_only: true,
      daily_mean: 1.84,
      basis: 'literature', refs: ['S1', 'S4', 'E1'],
      note: 'Mean 1.84 mSv/day measured in Mars cruise (E1), scaled by each person\'s dose_factor (illustrative shielding/position differences). Not recorded before flight.',
    },
  },

  /** Single-day events. */
  events: [
    {
      id: 'elevated-dose-day',
      metric: 'radiation_dose',
      day: 74,
      multiplier: 4,
      crew: 'all',
      basis: 'illustrative',
      refs: ['S1', 'S4'],
      note: 'An illustrative elevated-dose day, standing in for a solar particle event. The multiplier is not derived from any measured event.',
    },
  ],

  /** Per-person storylines, ramping in linearly over `ramp_days`. */
  storylines: [
    {
      id: 'novak-sleep-mood',
      crew: 'ms2',
      start_day: 45,
      ramp_days: 30,
      deltas: { sleep_duration: -0.9, mood: -1.0, heart_rate: 5 },
      basis: 'illustrative',
      refs: ['S2'],
      note: 'Illustrative storyline to exercise the baseline-deviation analytics: S2 names Risk of Inadequate Sleep and Irregular Schedules and Risk of Behavioral Changes and Psychiatric Disorders.',
    },
  ],

  /** Missing-data patterns. */
  gaps: [
    {
      id: 'chen-wearable-offline-mid',
      crew: 'ms1',
      source: 'synthetic-wearable',
      days: [61, 67],
      note: 'Wearable offline for seven days.',
    },
    {
      id: 'chen-wearable-offline-end',
      crew: 'ms1',
      source: 'synthetic-wearable',
      days: [118, 120],
      note: 'Wearable offline for the final three days, so the latest reading is stale.',
    },
    {
      id: 'okafor-skipped-evenings',
      crew: 'plt',
      source: 'synthetic-wearable',
      session: 'evening',
      fraction: 0.06,
      note: 'About 6% of evening wearable checks skipped.',
    },
    {
      id: 'bp-skipped-mornings',
      crew: 'all',
      source: 'synthetic-bp-cuff',
      fraction: 0.04,
      note: 'About 4% of morning blood-pressure readings not taken.',
    },
  ],
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** FNV-1a, to derive a stream seed from a name. */
function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: small, fast, and fully determined by its 32-bit seed. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A named, independent stream with uniform and gaussian draws. */
export function stream(seed, name) {
  const next = mulberry32((seed ^ hash32(name)) >>> 0)
  return {
    uniform: next,
    // Box–Muller. Draws two uniforms per value, always, so the stream
    // position never depends on a value.
    gauss: () => {
      const u = Math.max(next(), 1e-12)
      const v = next()
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    },
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** Mission day → calendar date. Day 1 is launch; −1 is the day before. */
export function dateOfDay(launchAt, day) {
  const offset = day > 0 ? day - 1 : day
  return new Date(Date.parse(launchAt) + offset * DAY_MS)
}

function at(launchAt, day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = dateOfDay(launchAt, day)
  d.setUTCHours(h, m, 0, 0)
  return d.toISOString()
}

/** End of the last simulated day: everything in the dataset is at or before it. */
export function scenarioNow(scenario = SCENARIO) {
  const d = dateOfDay(scenario.mission.launch_at, scenario.mission.inflight_days)
  d.setUTCHours(23, 59, 59, 0)
  return d.toISOString()
}

function change(spec, day, n, base, crewMean) {
  if (day < 1) return 0
  const c = spec.change
  if (!c) return 0
  if (c.shape === 'adapt') return c.amplitude * (1 - Math.exp(-day / c.tau_days))
  if (c.shape === 'drift') return (c.amplitude * day) / n
  if (c.shape === 'level') {
    const target = c.level + (base - crewMean) * c.personal_weight
    return (target - base) * (1 - Math.exp(-day / c.tau_days))
  }
  return 0
}

function storyline(scenario, crewId, metric, day) {
  let delta = 0
  for (const s of scenario.storylines) {
    if (s.crew !== crewId || !(metric in s.deltas)) continue
    const k = Math.min(1, Math.max(0, (day - s.start_day) / s.ramp_days))
    delta += s.deltas[metric] * k
  }
  return delta
}

function round(value, decimals) {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

/**
 * The full dataset, in a fixed order: crew, then metric, then day, then
 * session. Pure: no clock, no Math.random, no I/O.
 */
export function generate(scenario = SCENARIO) {
  const { mission, seed } = scenario
  const days = []
  for (let d = -mission.preflight_days; d <= -1; d++) days.push(d)
  for (let d = 1; d <= mission.inflight_days; d++) days.push(d)

  const rows = []
  for (const crew of scenario.crew) {
    // Gap decisions come from their own streams, so whether a reading is
    // skipped never shifts the values drawn for the readings that are kept.
    const skip = stream(seed, `${crew.id}:gaps`)
    const skipped = new Map()
    const isSkipped = (source, session, day) => {
      const key = `${source}|${session}|${day}`
      if (!skipped.has(key)) {
        let gone = false
        for (const g of scenario.gaps) {
          if (g.crew !== 'all' && g.crew !== crew.id) continue
          if (g.source !== source) continue
          if (g.session && g.session !== session) continue
          if (g.days && day >= g.days[0] && day <= g.days[1]) gone = true
          if (g.fraction && skip.uniform() < g.fraction) gone = true
        }
        skipped.set(key, gone)
      }
      return skipped.get(key)
    }

    for (const [code, spec] of Object.entries(scenario.metrics)) {
      const meta = METRIC[code]
      const rnd = stream(seed, `${crew.id}:${code}`)
      const base = crew.base[code]
      const crewMean =
        base === undefined ? 0 : scenario.crew.reduce((s, c) => s + c.base[code], 0) / scenario.crew.length

      for (const day of days) {
        for (const session of spec.sessions) {
          // Always draw, even for a reading that will be skipped, so the
          // values of every other reading are independent of the gaps.
          const noise = rnd.gauss()
          if (spec.inflight_only && day < 1) continue
          if (isSkipped(spec.source, session, day)) continue

          let value
          if (code === 'radiation_dose') {
            const ev = scenario.events.find((e) => e.metric === code && e.day === day && (e.crew === 'all' || e.crew === crew.id))
            value = (spec.daily_mean + noise * spec.noise_sd) * crew.dose_factor * (ev ? ev.multiplier : 1)
          } else {
            value =
              base +
              change(spec, day, mission.inflight_days, base, crewMean) +
              (session === 'evening' ? spec.evening_offset ?? 0 : 0) +
              storyline(scenario, crew.id, code, day) +
              noise * spec.noise_sd
          }
          if (spec.max !== undefined) value = Math.min(spec.max, value)
          if (spec.min !== undefined) value = Math.max(spec.min, value)

          rows.push({
            astronaut_id: crew.id,
            metric_code: code,
            value: round(value, meta.decimals),
            unit: meta.unit,
            observed_at: at(mission.launch_at, day, scenario.sessions[session]),
            mission_day: day,
            phase: day < 1 ? 'preflight' : 'inflight',
            source_id: spec.source,
            is_simulated: 1,
            session,
          })
        }
      }
    }
  }
  return rows
}
