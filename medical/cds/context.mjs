/**
 * Build the context an assessment is evaluated against, from the existing
 * medical data service: current readings, personal baselines, short-term
 * means and trends, mission context, and the self-assessment answers.
 *
 * A reading that is stale (older than the service's freshness window) is NOT
 * a current value here: `value` is null and the rules that need it cannot
 * fire. The last reading is still carried, so the missing-data report can
 * say how old it is.
 */

/** Days of data a 7-day mean needs before it is used. Prototype assumption. */
export const MEAN7_MIN_DAYS = 4
/** Share of days a 14-day trend needs before its slope is used. Prototype assumption. */
export const TREND14_MIN_COVERAGE = 0.5

function metricContext(service, crewId, code, summary) {
  const s = summary.metrics[code]
  const cur = s.latest && !s.latest.stale ? s.latest : null
  const t7 = service.trend(crewId, code, { days: 7 }).trend
  const t14 = service.trend(crewId, code, { days: 14 }).trend
  const base = s.baseline
  const mean7 = t7.days_with_data >= MEAN7_MIN_DAYS ? t7.mean : null
  return {
    value: cur ? cur.value : null,
    unit: s.unit,
    observed_at: cur?.observed_at ?? null,
    observation_id: cur?.observation_id ?? null,
    source_id: cur?.source_id ?? null,
    is_simulated: cur ? cur.is_simulated : null,
    baseline: base ? { mean: base.mean, sd: base.sd, n: base.n, method: base.method } : null,
    // z of the current reading against the person's own baseline.
    z: s.deviation?.z ?? null,
    mean7,
    days7: t7.days_with_data,
    // z of the 7-day mean against the baseline (daily SD: conservative).
    z7: mean7 !== null && base && base.sd > 0 ? Math.round(((mean7 - base.mean) / base.sd) * 100) / 100 : null,
    trend14:
      t14.coverage !== null && t14.coverage >= TREND14_MIN_COVERAGE && t14.slope_per_week !== null
        ? t14.slope_per_week
        : null,
    // Standard error of that slope: a trend counts only when it clears noise.
    trend14_se: t14.coverage !== null && t14.coverage >= TREND14_MIN_COVERAGE ? t14.slope_se_per_week : null,
    coverage14: t14.coverage,
    last_reading: s.latest
      ? { value: s.latest.value, observed_at: s.latest.observed_at, age_hours: s.latest.age_hours, stale: s.latest.stale }
      : null,
  }
}

export function buildContext(service, crewId, metrics, answers = {}) {
  const summary = service.summary(crewId) // throws 404 for an unknown crew id
  const mission = service.mission().mission
  return {
    crew: { id: summary.astronaut.id, callsign: summary.astronaut.callsign, role: summary.astronaut.role, is_synthetic: summary.astronaut.is_synthetic },
    mission: {
      mission_id: mission.id,
      destination: mission.destination,
      mission_day: mission.inflight_days,
      phase: 'inflight',
      // Context only: in transit there is no gravity, so standing up places no
      // orthostatic load on the heart (S1: gravity fields).
      environment: 'microgravity (interplanetary transit)',
      scenario_now: mission.scenario_now,
    },
    data: Object.fromEntries(metrics.map((code) => [code, metricContext(service, crewId, code, summary)])),
    answers,
    dataset_sha256: service.provenance().dataset_sha256,
  }
}
