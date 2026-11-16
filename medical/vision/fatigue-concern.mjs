/**
 * Camera-supported fatigue concern (Step 26D).
 *
 * A separate, transparent classification that puts three sources of evidence
 * together:
 *
 *   1. the sleep and fatigue assessment (medical/cds/sleep-fatigue.mjs, the
 *      rules engine), which already reads sleep history against the personal
 *      baseline and the crew member's own answers;
 *   2. the crew member's self-report and sleep history, shown as context;
 *   3. the camera's PERCLOS and sustained eye closures, used only when the
 *      measurement is reliable.
 *
 * It returns low, moderate, high or indeterminate, with every contributing
 * indicator listed. Three rules are enforced here, and tested:
 *
 *   - The rules engine is untouched and still decides clinical escalation.
 *     This classification reads its result; it never changes it.
 *   - The rules engine's level sets a floor. A reliable camera observation
 *     may RAISE the concern above that floor; nothing here can lower it.
 *   - An unreliable, missing, old or implausible camera observation is set
 *     aside with the reason, never read as normal. When the assessment is
 *     incomplete too, the concern is indeterminate, not low.
 *
 * Every camera threshold below is a prototype assumption, informed by the
 * literature but not validated for this webcam, this software or spaceflight
 * (docs/alertness-assessment.md). Published PERCLOS studies use different
 * definitions and cut-offs, and no single value is established (Abe 2023).
 *
 * Pure functions over plain data, so any model (or none) gets the same
 * answer.
 */

import { SLEEP_FATIGUE } from '../cds/sleep-fatigue.mjs'

export const METHOD = 'camera_supported_fatigue_concern_v1'

export const CONCERN_LEVELS = ['low', 'moderate', 'high']
const rank = (l) => CONCERN_LEVELS.indexOf(l)
const higher = (a, b) => (rank(b) > rank(a) ? b : a)

/**
 * The camera thresholds, all prototype. Each has its basis written beside it
 * so the explanation, the record and the documentation say the same thing.
 */
export const THRESHOLDS = {
  /** A camera observation older than this is not used. */
  MAX_AGE_MIN: { value: 60, basis: 'prototype', note: 'A one-minute observation describes that moment, not the day.' },
  /** PERCLOS (P80) at or above this counts as elevated. */
  PERCLOS_ELEVATED: {
    value: 0.15,
    basis: 'prototype, literature-informed',
    note: 'The same value MeBo already uses as its follow-up cue. PERCLOS rises with drowsiness in laboratory and driving studies (FHWA 1998; Dinges et al. 1998), but published cut-offs differ by definition and device (Abe 2023); this one is not validated here.',
  },
  /** A closure this long or longer is a sustained closure, not a blink. */
  SUSTAINED_CLOSURE_S: {
    value: 2,
    basis: 'prototype, literature-informed',
    note: 'Well beyond normal blink durations (Caffier et al. 2003); brief sleep episodes are commonly defined as lasting up to about 15 s (Hertig-Godeschalk et al. 2020). MeBo measured sustained closures close to the truth in its validation.',
  },
  /** At least this many sustained closures in the observation counts as elevated. */
  SUSTAINED_CLOSURES_ELEVATED: { value: 1, basis: 'prototype', note: 'One sustained closure during a guided one-minute check.' },
  /**
   * Above these, the reading is set aside as implausible: someone following a
   * guided check with their eyes closed this much of the time, or for this
   * long, is more likely a tracking failure (looking down, glare, a covered
   * eye) than a measurement. Not treated as normal either — the questions
   * ask directly about falling asleep.
   */
  PERCLOS_IMPLAUSIBLE: { value: 0.5, basis: 'prototype', note: 'Eyes closed for half of a guided check.' },
  CLOSURE_IMPLAUSIBLE_S: {
    value: 15,
    basis: 'prototype, literature-informed',
    note: 'Longer than the usual upper bound of a brief sleep episode (Hertig-Godeschalk et al. 2020).',
  },
}

/**
 * How the rules engine's level sets the floor. The mapping is MeBo's
 * prototype; the levels themselves are the engine's.
 */
export const FLOOR_FROM_RULES = { none: 'low', monitor: 'low', review: 'moderate', urgent: 'high', emergency: 'high' }

export const REFERENCES = [
  {
    id: 'NASA-HRP-SLEEP',
    kind: 'NASA',
    passage_id: 'S2:risk-of-inadequate-sleep-and-irregular-schedules',
    // Filled from the knowledge base (verbatim, with retrieval details) by medical/workflows.mjs.
    citation: 'NASA Human Research Program — the sleep and irregular-schedules risk (MeBo knowledge base).',
  },
  {
    id: 'Abe2023',
    kind: 'peer-reviewed',
    citation: 'Abe, T. (2023). PERCLOS-based technologies for detecting drowsiness: current evidence and future directions. SLEEP Advances, 4(1), zpad006.',
    url: 'https://doi.org/10.1093/sleepadvances/zpad006',
  },
  {
    id: 'FHWA1998',
    kind: 'technical report',
    citation: 'Federal Highway Administration (1998). PERCLOS: A Valid Psychophysiological Measure of Alertness as Assessed by Psychomotor Vigilance. Tech Brief FHWA-MCRT-98-006.',
    url: 'https://trid.trb.org/view/498744',
  },
  {
    id: 'Dinges1998',
    kind: 'technical report',
    citation: 'Dinges, D. F., Mallis, M. M., Maislin, G., & Powell, J. W. (1998). Evaluation of Techniques for Ocular Measurement as an Index of Fatigue and the Basis for Alertness Management. NHTSA, DOT HS 808 762.',
  },
  {
    id: 'Caffier2003',
    kind: 'peer-reviewed',
    citation: 'Caffier, P. P., Erdmann, U., & Ullsperger, P. (2003). Experimental evaluation of eye-blink parameters as a drowsiness measure. European Journal of Applied Physiology, 89(3–4), 319–325.',
    url: 'https://doi.org/10.1007/s00421-003-0807-5',
  },
  {
    id: 'HertigGodeschalk2020',
    kind: 'peer-reviewed',
    citation: 'Hertig-Godeschalk, A., Skorucak, J., Malafeev, A., Achermann, P., Mathis, J., & Schreier, D. R. (2020). Microsleep episodes in the borderland between wakefulness and sleep. Sleep, 43(1), zsz163.',
    url: 'https://doi.org/10.1093/sleep/zsz163',
  },
]

export const LIMITATIONS = [
  'This classification is a MeBo prototype. It is not a diagnosis, not a clinical escalation and not a fitness-for-duty decision; the rules engine and the crew medical officer decide those.',
  'Camera thresholds are prototype assumptions informed by driving and laboratory research; none is validated for this webcam, this software, this population or spaceflight.',
  'A one-minute observation is a snapshot. Looking down, reading, glare, dry eyes or eye shape can raise PERCLOS without any change in alertness.',
  'The camera can only raise the concern. A normal camera reading never lowers what the sleep history and answers show.',
]

const SOURCE_OF_RULE = { SL: 'sleep_history', FT: 'self_report', SC: 'schedule', MD: 'mood' }
const RULES = Object.fromEntries(SLEEP_FATIGUE.rules.map((r) => [r.id, r]))
const pct = (v) => `${Math.round(v * 100)}%`

/**
 * Is this camera observation usable for the concern? Returns
 * { status: 'used' | 'missing' | 'stale' | 'rejected', reasons, alertness }.
 */
export function cameraUsability(observation, ageMin) {
  const a = observation?.alertness ?? null
  if (!observation) return { status: 'missing', reasons: ['no camera observation on record'], alertness: null }
  if (ageMin !== null && ageMin !== undefined && ageMin > THRESHOLDS.MAX_AGE_MIN.value) {
    return { status: 'stale', reasons: [`the camera check is ${Math.round(ageMin)} minutes old`], alertness: a }
  }
  if (observation.face_visible_ratio === 0) return { status: 'rejected', reasons: ['no face was detected'], alertness: a }
  if (!a) return { status: 'rejected', reasons: ['the check had no natural-observation eye measures'], alertness: null }
  if (a.quality?.grade === 'insufficient' || a.perclos_p80 === null || a.perclos_p80 === undefined) {
    return { status: 'rejected', reasons: [`eye-measure quality insufficient (${(a.quality?.reasons ?? []).join(', ') || 'no reason given'})`], alertness: a }
  }
  const implausible = []
  if (a.perclos_p80 > THRESHOLDS.PERCLOS_IMPLAUSIBLE.value) implausible.push(`PERCLOS ${pct(a.perclos_p80)} is beyond what a guided check can plausibly measure`)
  if (a.longest_closure_s > THRESHOLDS.CLOSURE_IMPLAUSIBLE_S.value) implausible.push(`a ${a.longest_closure_s.toFixed(1)} s closure is longer than the camera can plausibly measure in a guided check`)
  if (implausible.length) return { status: 'rejected', reasons: implausible, alertness: a, implausible: true }
  return { status: 'used', reasons: [], alertness: a }
}

/**
 * The camera's own contribution: which indicators are elevated, and the
 * highest level they can support. Limited quality can support moderate at
 * most; high needs good quality and both indicators agreeing.
 */
function cameraSignal(a) {
  const perclosHigh = a.perclos_p80 >= THRESHOLDS.PERCLOS_ELEVATED.value
  const sustained = (a.prolonged_closures ?? 0) >= THRESHOLDS.SUSTAINED_CLOSURES_ELEVATED.value
  const count = Number(perclosHigh) + Number(sustained)
  let level = 'low'
  if (count === 2 && a.quality.grade === 'good') level = 'high'
  else if (count >= 1) level = 'moderate'
  return { perclosHigh, sustained, level }
}

/**
 * Classify the fatigue concern.
 *
 * @param f.assessment   the sleep_fatigue assessment as filed in memory
 *                       ({ assessment_id, at, status, level, summary, rule_ids, missing }), or null
 * @param f.observation  the latest camera observation (validated), or null
 * @param f.observationId, f.observationAt, f.observationAgeMin
 * @param f.sleep        recent sleep history (recentHistory shape), or null
 * @param f.selfReport   { fatigue: {value, age_minutes}|null, dozed_on_task: {...}|null }
 */
export function classifyFatigueConcern({ assessment, observation, observationId = null, observationAt = null, observationAgeMin = null, sleep = null, selfReport = {} }) {
  const contributors = []

  // --- 1. the rules engine: the floor ---------------------------------------------------
  let floor
  if (!assessment) {
    floor = 'indeterminate'
  } else {
    floor = FLOOR_FROM_RULES[assessment.level] ?? 'low'
    // Incomplete with nothing found: the rules could not conclude, so neither can this.
    if (assessment.status === 'incomplete' && rank(floor) < rank('moderate')) floor = 'indeterminate'
    for (const id of assessment.rule_ids ?? []) {
      const r = RULES[id]
      if (!r) continue
      contributors.push({
        source: SOURCE_OF_RULE[id.split('-')[0]] ?? 'rules_engine',
        via: 'rules_engine',
        indicator: r.title,
        rule_id: id,
        rules_level: r.level,
        effect: FLOOR_FROM_RULES[r.level] === floor ? 'sets_floor' : 'supports',
        basis: r.basis,
      })
    }
  }

  // --- 2. sleep history and self-report, as context ---------------------------------
  const context = []
  if (sleep?.mean_7_days !== null && sleep?.mean_7_days !== undefined) {
    context.push({
      source: 'sleep_history',
      indicator: '7-night sleep average',
      value: `${Number(sleep.mean_7_days).toFixed(1)} h`,
      baseline: sleep.baseline_mean !== null && sleep.baseline_mean !== undefined ? `${sleep.baseline_mean} h` : null,
      note: 'Read by the rules engine (sleep rules); synthetic demonstration data.',
    })
  } else {
    context.push({ source: 'sleep_history', indicator: '7-night sleep average', value: null, note: 'Not enough recent sleep data.' })
  }
  context.push({
    source: 'self_report',
    indicator: 'Self-rated tiredness',
    value: selfReport?.fatigue ? `${selfReport.fatigue.value} of 5` : null,
    note: selfReport?.fatigue ? 'Read by the rules engine (fatigue rules).' : 'Not answered.',
  })
  if (selfReport?.dozed_on_task) {
    context.push({ source: 'self_report', indicator: 'Fell asleep during a task', value: String(selfReport.dozed_on_task.value), note: 'Read by the rules engine.' })
  }

  // --- 3. the camera, only when reliable ------------------------------------------------
  const use = cameraUsability(observation, observationAgeMin)
  const a = use.alertness
  let cameraLevel = null
  const camera = {
    status: use.status,
    reasons: use.reasons,
    observation_id: observationId,
    at: observationAt,
    age_minutes: observationAgeMin === null ? null : Math.round(observationAgeMin),
    quality: a?.quality?.grade ?? null,
    perclos_p80: a?.perclos_p80 ?? null,
    prolonged_closures: a?.prolonged_closures ?? null,
    longest_closure_s: a?.longest_closure_s ?? null,
    valid_s: a?.valid_s ?? null,
    supports_level: null,
  }
  if (use.status === 'used') {
    const s = cameraSignal(a)
    cameraLevel = s.level
    camera.supports_level = s.level
    contributors.push(
      {
        source: 'camera',
        indicator: 'PERCLOS (eyes at least 80% closed)',
        value: pct(a.perclos_p80),
        threshold: `≥ ${pct(THRESHOLDS.PERCLOS_ELEVATED.value)}`,
        effect: s.perclosHigh ? 'elevated' : 'within',
        basis: THRESHOLDS.PERCLOS_ELEVATED.basis,
      },
      {
        source: 'camera',
        indicator: `Sustained eye closures (≥ ${THRESHOLDS.SUSTAINED_CLOSURE_S.value} s)`,
        value: `${a.prolonged_closures ?? 0} (longest ${Number(a.longest_closure_s ?? 0).toFixed(1)} s)`,
        threshold: `≥ ${THRESHOLDS.SUSTAINED_CLOSURES_ELEVATED.value}`,
        effect: s.sustained ? 'elevated' : 'within',
        basis: THRESHOLDS.SUSTAINED_CLOSURES_ELEVATED.basis,
      },
      {
        source: 'camera',
        indicator: 'Measurement quality',
        value: a.quality.grade,
        effect: a.quality.grade === 'good' ? 'within' : 'limits',
        note: a.quality.grade === 'good' ? 'Good quality: the camera can support up to high.' : 'Limited quality: the camera can support moderate at most.',
        basis: 'prototype',
      },
    )
  } else {
    contributors.push({ source: 'camera', indicator: 'Camera observation', value: use.status, effect: 'excluded', note: use.reasons.join('; '), basis: 'prototype' })
  }

  // --- combine: never below the floor ----------------------------------------------------
  let level
  if (floor === 'indeterminate') {
    level = cameraLevel && rank(cameraLevel) >= rank('moderate') ? cameraLevel : 'indeterminate'
  } else {
    level = cameraLevel ? higher(floor, cameraLevel) : floor
  }
  const raisedByCamera = cameraLevel !== null && level !== 'indeterminate' && (floor === 'indeterminate' || rank(level) > rank(floor))
  for (const c of contributors) {
    if (c.source === 'camera' && c.effect === 'elevated') c.effect = raisedByCamera ? 'raised' : 'supports'
  }

  // --- conflicting evidence, said plainly ---------------------------------------------
  const conflicts = []
  const selfLow = selfReport?.fatigue && selfReport.fatigue.value <= 2 && selfReport?.dozed_on_task?.value !== 'yes'
  if (raisedByCamera && (selfLow || rank(floor) === rank('low'))) {
    conflicts.push('The camera measures were elevated, but the sleep history and answers did not show a concern. The camera raised the concern; it may also be a measurement effect (looking down, glare).')
  }
  if (cameraLevel === 'low' && rank(floor) >= rank('moderate')) {
    conflicts.push('The camera measures were within the prototype limits, but the sleep history or answers showed a concern. A normal camera reading does not lower that concern.')
  }

  const result = {
    method: METHOD,
    level,
    rules_floor: floor,
    rules_assessment: assessment && {
      assessment_id: assessment.assessment_id,
      at: assessment.at,
      level: assessment.level,
      status: assessment.status,
      missing: assessment.missing ?? [],
    },
    clinical_escalation_unchanged: true,
    raised_by_camera: raisedByCamera,
    camera,
    contributors,
    context,
    conflicts,
    thresholds: Object.fromEntries(Object.entries(THRESHOLDS).map(([k, t]) => [k, { value: t.value, basis: t.basis }])),
    references: REFERENCES,
    limitations: LIMITATIONS,
  }
  return { ...result, explanation: explainConcern(result), spoken: spokenConcern(result) }
}

const LEVEL_WORD = { low: 'low', moderate: 'moderate', high: 'high', indeterminate: 'indeterminate' }

function cameraClause(r) {
  const c = r.camera
  if (c.status !== 'used') return `The camera was not used, because ${c.reasons.join('; ')}. That is not a sign that everything is fine.`
  const elevated = r.contributors.filter((x) => x.source === 'camera' && (x.effect === 'raised' || x.effect === 'supports'))
  const measured = `Your eyes were mostly closed ${pct(c.perclos_p80)} of the time, with ${c.prolonged_closures ?? 0} sustained eye closure${c.prolonged_closures === 1 ? '' : 's'}`
  if (!elevated.length) return `${measured}, within the prototype limits${c.quality === 'limited' ? ', at limited quality' : ''}. That does not lower the concern.`
  return `${measured}${c.quality === 'limited' ? ', at limited quality' : ''}. ${r.raised_by_camera ? 'The camera raised the concern.' : 'The camera agreed with the concern.'}`
}

/** Written explanation, for the screen and memory. */
export function explainConcern(r) {
  const parts = []
  const floorWhy = !r.rules_assessment
    ? 'There is no sleep and fatigue assessment to build on.'
    : r.rules_floor === 'indeterminate'
      ? `The sleep and fatigue assessment was incomplete (${r.rules_assessment.missing.join(', ') || 'answers missing'}), so it could not conclude.`
      : `The sleep and fatigue assessment (rules engine) was ${r.rules_assessment.level.toUpperCase()}, which sets a floor of ${r.rules_floor}.`
  parts.push(floorWhy)
  const fromRules = r.contributors.filter((x) => x.via === 'rules_engine').map((x) => x.indicator.toLowerCase())
  if (fromRules.length) parts.push(`From sleep history and answers: ${fromRules.join('; ')}.`)
  parts.push(cameraClause(r))
  parts.push(...r.conflicts)
  parts.push(
    r.level === 'indeterminate'
      ? 'The fatigue concern is indeterminate: there is not enough reliable evidence to say.'
      : `The combined fatigue concern is ${r.level}.`,
  )
  parts.push('This is a prototype classification. The rules engine\'s escalation guidance still applies unchanged.')
  return parts.join(' ')
}

/** What MeBo says, after the rules engine's guidance. Short and in plain words. */
export function spokenConcern(r) {
  const head =
    r.level === 'indeterminate'
      ? 'Putting your sleep, your answers and the camera together, I cannot say how tired you are: there is not enough reliable information.'
      : `Putting your sleep, your answers and the camera together, my fatigue concern is ${LEVEL_WORD[r.level]}.`
  const why = []
  const fromRules = r.contributors.filter((x) => x.via === 'rules_engine' && x.rules_level !== 'monitor').map((x) => x.indicator.toLowerCase())
  if (fromRules.length) why.push(`That comes from ${fromRules.slice(0, 3).join(' and ')}.`)
  why.push(cameraClause(r))
  if (r.conflicts.length) why.push(r.raised_by_camera ? 'Your answers and the camera point different ways, so I have taken the more cautious view.' : '')
  return [head, ...why, 'This is a prototype measure, not a diagnosis, and it does not change the guidance I just gave.'].filter(Boolean).join(' ')
}
