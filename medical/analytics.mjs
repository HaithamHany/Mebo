/**
 * Descriptive analytics over observation series: individual baselines,
 * historical trends, and how far the latest reading sits from the person's
 * own baseline.
 *
 * Pure functions — no database, no clock, no language model — so the same
 * numbers come out whichever interface (dashboard, CLI, a future offline LLM
 * tool) asks for them.
 *
 * Deliberately descriptive. Nothing here classifies a value as normal or
 * abnormal, applies a clinical threshold, or suggests a treatment: a z-score
 * says how unusual a reading is *for this person*, statistically, and nothing
 * about what it means medically.
 */

const round = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d)

function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

/** Sample standard deviation (n − 1). */
function sd(xs) {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** Fewest observations a baseline may be computed from. */
export const MIN_BASELINE_N = 5
/** In-flight window used when there is no pre-flight data. */
export const EARLY_INFLIGHT_DAYS = 14

/**
 * The person's own reference values for one metric.
 *
 * Pre-flight observations are the baseline: they are the person on the
 * ground, before any spaceflight adaptation. Without enough of them, the
 * first two weeks of flight are used instead, and the method says so.
 */
export function baseline(points, decimals = 2) {
  let method = 'preflight'
  let use = points.filter((p) => p.phase === 'preflight')
  if (use.length < MIN_BASELINE_N) {
    method = 'early-inflight'
    use = points.filter((p) => p.phase === 'inflight' && p.mission_day <= EARLY_INFLIGHT_DAYS)
  }
  if (use.length < MIN_BASELINE_N) return null
  const values = use.map((p) => p.value)
  return {
    method,
    mean: round(mean(values), decimals + 1),
    sd: round(sd(values), decimals + 1),
    median: round(median(values), decimals + 1),
    n: values.length,
    from_day: Math.min(...use.map((p) => p.mission_day)),
    to_day: Math.max(...use.map((p) => p.mission_day)),
  }
}

/** One value per mission day: the mean of that day's observations. */
export function dailySeries(points) {
  const byDay = new Map()
  for (const p of points) {
    if (!byDay.has(p.mission_day)) byDay.set(p.mission_day, [])
    byDay.get(p.mission_day).push(p.value)
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, vs]) => ({ day, mean: mean(vs), n: vs.length }))
}

/** Ordinary least squares slope of y on x. */
function slope(xs, ys) {
  if (xs.length < 2) return null
  const mx = mean(xs)
  const my = mean(ys)
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? null : num / den
}

/**
 * Standard error of the OLS slope. Day-to-day noise alone produces sizeable
 * slopes over a short window, and without this a trend rule mostly detects
 * noise. Needs at least three points.
 */
function slopeSe(xs, ys, b) {
  if (xs.length < 3 || b === null) return null
  const mx = mean(xs)
  const my = mean(ys)
  const a = my - b * mx
  let rss = 0
  let sxx = 0
  for (let i = 0; i < xs.length; i++) {
    rss += (ys[i] - (a + b * xs[i])) ** 2
    sxx += (xs[i] - mx) ** 2
  }
  return sxx === 0 ? null : Math.sqrt(rss / (xs.length - 2) / sxx)
}

/**
 * The trend over a window of mission days, inclusive.
 *
 * `missing_days` lists days in the window with no observation at all, so a
 * gap in the record is reported as a gap rather than silently bridged.
 * Mission day 0 does not exist (day −1 is followed by day 1), so it is never
 * counted as missing.
 */
export function trend(points, fromDay, toDay, decimals = 2) {
  const inWindow = points.filter((p) => p.mission_day >= fromDay && p.mission_day <= toDay)
  const daily = dailySeries(inWindow)
  const window = []
  for (let d = fromDay; d <= toDay; d++) if (d !== 0) window.push(d)
  const have = new Set(daily.map((x) => x.day))
  const missing = window.filter((d) => !have.has(d))
  const xs = daily.map((x) => x.day)
  const ys = daily.map((x) => x.mean)
  const perDay = slope(xs, ys)
  const se = slopeSe(xs, ys, perDay)
  return {
    from_day: fromDay,
    to_day: toDay,
    daily: daily.map((x) => ({ day: x.day, mean: round(x.mean, decimals + 1), n: x.n })),
    mean: daily.length ? round(mean(inWindow.map((p) => p.value)), decimals + 1) : null,
    slope_per_week: perDay === null ? null : round(perDay * 7, decimals + 2),
    slope_se_per_week: se === null ? null : round(se * 7, decimals + 2),
    observations: inWindow.length,
    days_in_window: window.length,
    days_with_data: daily.length,
    coverage: window.length ? round(daily.length / window.length, 3) : null,
    missing_days: missing,
  }
}

/**
 * The most recent observation at or before `now`, with its age. A reading
 * older than `staleAfterHours` is still returned but marked stale, so callers
 * can tell "no current reading" from "this is the current reading".
 */
export function latest(points, now, staleAfterHours) {
  const t = Date.parse(now)
  let best = null
  for (const p of points) {
    const pt = Date.parse(p.observed_at)
    if (pt <= t && (!best || pt > Date.parse(best.observed_at))) best = p
  }
  if (!best) return null
  const age = (t - Date.parse(best.observed_at)) / 3_600_000
  return {
    // The row this reading came from, so anything built on it can be traced
    // back to the database.
    observation_id: best.id ?? null,
    value: best.value,
    unit: best.unit,
    observed_at: best.observed_at,
    mission_day: best.mission_day,
    source_id: best.source_id,
    is_simulated: best.is_simulated === 1,
    age_hours: round(age, 1),
    stale: age > staleAfterHours,
  }
}

/**
 * How far a current reading sits from the person's baseline: the difference
 * and the z-score. Statistical, not clinical. Null when there is no current
 * reading, no baseline, or no spread to measure against.
 */
export function deviation(current, base, decimals = 2) {
  if (!current || current.stale || !base) return null
  const delta = current.value - base.mean
  return {
    delta: round(delta, decimals + 1),
    z: base.sd > 0 ? round(delta / base.sd, 2) : null,
    baseline_method: base.method,
  }
}

export function total(points) {
  return points.reduce((s, p) => s + p.value, 0)
}
