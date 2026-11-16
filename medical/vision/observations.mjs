/**
 * Camera observations, as the medical service accepts and stores them.
 *
 * The browser runs the guided camera check (src/lib/visual/) and posts only a
 * numeric summary: counts, ranges, which instructed tasks were completed and,
 * since Step 26B, the natural-observation measures (EAR calibration, PERCLOS,
 * blinks, closures) with their measurement quality. This module is the gate on
 * the way in. It accepts exactly that shape and nothing else — every field is
 * a known key, a number within bounds, a boolean, or one of a fixed set of
 * values. There is no free text at all, so nothing diagnostic can be written
 * into a crew member's record through it.
 *
 * Observations are supplementary. They are stored in the crew member's
 * conversational memory (medical/memory), never in the medical database, and
 * the rules engine never reads them: no assessment, concern or escalation
 * level depends on anything here (test/visual-observation.test.mjs and
 * test/alertness.test.mjs prove it).
 */

import { MedicalError } from '../service.mjs'

/** The current protocol, and the one before it (still readable and accepted). */
export const PROTOCOL = 'face_alertness_v2'
export const PROTOCOL_V1 = 'face_basic_v1'

/** Must match TASKS in src/lib/visual/observe.ts (a test checks it). */
export const TASK_IDS = ['face_camera', 'natural_gaze', 'eyes_closed', 'head_turn', 'hold_still']
const TASK_IDS_V1 = ['face_camera', 'eyes_closed', 'head_turn', 'hold_still']

/** Must match QUALITY_REASONS in src/lib/visual/observe.ts (a test checks it). */
export const QUALITY_REASONS = [
  'no_observation', 'short_observation', 'below_window', 'very_low_frame_rate', 'low_frame_rate',
  'missing_frames', 'head_turned', 'face_too_small', 'eye_asymmetry', 'no_closed_calibration', 'closure_not_detected',
  'low_agreement', 'too_dark', 'too_bright', 'illumination_changed',
]

export const VISUAL_NOTICE =
  'Camera observation only: what the video showed (face in view, eye opening, PERCLOS, blinks, head ' +
  'movement, tasks completed). Not a diagnosis, not a measure of fitness for duty, and not evidence of ' +
  'fatigue, illness or mood on its own. Supplementary to the rule-based assessments; it never changes an ' +
  'assessment or an escalation level.'

const bad = (msg) => new MedicalError(400, `observation: ${msg}`)

function num(v, name, lo, hi, { int = false, nullable = false } = {}) {
  if (v === null && nullable) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) {
    throw bad(`${name} must be ${int ? 'an integer' : 'a number'} from ${lo} to ${hi}${nullable ? ' or null' : ''}`)
  }
  return v
}

function only(obj, keys, name) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw bad(`${name} must be an object`)
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw bad(`${name} has no field "${k}"`)
  for (const k of keys) if (!(k in obj)) throw bad(`${name} is missing "${k}"`)
  return obj
}

function oneOf(v, allowed, name) {
  if (!allowed.includes(v)) throw bad(`${name} must be one of ${allowed.join(', ')}`)
  return v
}

function validateAlertness(a) {
  if (a === null) return null
  only(
    a,
    [
      'window_s', 'observed_s', 'valid_s', 'valid_frame_ratio', 'fps', 'max_gap_s', 'calibration',
      'perclos_p80', 'perclos_blendshape', 'blink_rate_per_min', 'blink_count', 'mean_blink_duration_s',
      'longest_closure_s', 'prolonged_closures', 'agreement', 'luma_mean', 'luma_range', 'quality',
    ],
    'alertness',
  )
  const c = only(a.calibration, ['method', 'open_ear', 'closed_ear'], 'alertness.calibration')
  const q = only(a.quality, ['grade', 'reasons'], 'alertness.quality')
  if (!Array.isArray(q.reasons) || q.reasons.length > QUALITY_REASONS.length) throw bad('alertness.quality.reasons must be a list')
  const reasons = q.reasons.map((x, i) => oneOf(x, QUALITY_REASONS, `alertness.quality.reasons[${i}]`))
  if (new Set(reasons).size !== reasons.length) throw bad('alertness.quality.reasons has duplicates')
  const grade = oneOf(q.grade, ['good', 'limited', 'insufficient'], 'alertness.quality.grade')
  const out = {
    window_s: num(a.window_s, 'alertness.window_s', 20, 180, { int: true }),
    observed_s: num(a.observed_s, 'alertness.observed_s', 0, 600),
    valid_s: num(a.valid_s, 'alertness.valid_s', 0, 600),
    valid_frame_ratio: num(a.valid_frame_ratio, 'alertness.valid_frame_ratio', 0, 1),
    fps: num(a.fps, 'alertness.fps', 0, 120),
    max_gap_s: num(a.max_gap_s, 'alertness.max_gap_s', 0, 600),
    calibration: {
      method: oneOf(c.method, ['two_point', 'uncalibrated'], 'alertness.calibration.method'),
      open_ear: num(c.open_ear, 'alertness.calibration.open_ear', 0, 2, { nullable: true }),
      closed_ear: num(c.closed_ear, 'alertness.calibration.closed_ear', 0, 2, { nullable: true }),
    },
    perclos_p80: num(a.perclos_p80, 'alertness.perclos_p80', 0, 1, { nullable: true }),
    perclos_blendshape: num(a.perclos_blendshape, 'alertness.perclos_blendshape', 0, 1, { nullable: true }),
    blink_rate_per_min: num(a.blink_rate_per_min, 'alertness.blink_rate_per_min', 0, 300, { nullable: true }),
    blink_count: num(a.blink_count, 'alertness.blink_count', 0, 2000, { int: true }),
    mean_blink_duration_s: num(a.mean_blink_duration_s, 'alertness.mean_blink_duration_s', 0, 5, { nullable: true }),
    longest_closure_s: num(a.longest_closure_s, 'alertness.longest_closure_s', 0, 600),
    prolonged_closures: num(a.prolonged_closures, 'alertness.prolonged_closures', 0, 1000, { int: true }),
    agreement: num(a.agreement, 'alertness.agreement', 0, 1, { nullable: true }),
    luma_mean: num(a.luma_mean, 'alertness.luma_mean', 0, 255, { nullable: true }),
    luma_range: num(a.luma_range, 'alertness.luma_range', 0, 255, { nullable: true }),
    quality: { grade, reasons },
  }
  // Rates are not reported from an insufficient measurement.
  if (grade === 'insufficient' && (out.perclos_p80 !== null || out.blink_rate_per_min !== null)) {
    throw bad('an insufficient measurement reports no PERCLOS or blink rate')
  }
  return out
}

/**
 * Validate a summary from the browser and return a clean copy. Throws a 400
 * MedicalError naming the first problem.
 */
export function validateObservation(o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw bad('observation must be an object')
  const v2 = o.protocol === PROTOCOL
  if (!v2 && o.protocol !== PROTOCOL_V1) throw bad(`protocol must be "${PROTOCOL}"`)
  only(
    o,
    ['protocol', 'duration_s', 'frames', 'fps', 'face_visible_ratio', 'tasks', 'indicators', ...(v2 ? ['alertness'] : [])],
    'observation',
  )
  const ids = v2 ? TASK_IDS : TASK_IDS_V1
  if (!Array.isArray(o.tasks) || o.tasks.length > ids.length) throw bad(`tasks must be a list of at most ${ids.length}`)
  const seen = new Set()
  const tasks = o.tasks.map((t, i) => {
    only(t, ['id', 'completed', 'seconds'], `tasks[${i}]`)
    if (!ids.includes(t.id)) throw bad(`tasks[${i}].id must be one of ${ids.join(', ')}`)
    if (seen.has(t.id)) throw bad(`task ${t.id} appears twice`)
    seen.add(t.id)
    if (typeof t.completed !== 'boolean') throw bad(`tasks[${i}].completed must be true or false`)
    return { id: t.id, completed: t.completed, seconds: num(t.seconds, `tasks[${i}].seconds`, 0, 300) }
  })
  const ind = only(
    o.indicators,
    [
      'blinks', 'longest_unprompted_eye_closure_s', 'prolonged_unprompted_eye_closures',
      'head_yaw_range_deg', 'head_pitch_range_deg', 'hold_still_movement', 'hold_still_steady',
    ],
    'indicators',
  )
  if (ind.hold_still_steady !== null && typeof ind.hold_still_steady !== 'boolean') {
    throw bad('indicators.hold_still_steady must be true, false or null')
  }
  return {
    protocol: v2 ? PROTOCOL : PROTOCOL_V1,
    duration_s: num(o.duration_s, 'duration_s', 0, 900),
    frames: num(o.frames, 'frames', 0, 50000, { int: true }),
    fps: num(o.fps, 'fps', 0, 120),
    face_visible_ratio: num(o.face_visible_ratio, 'face_visible_ratio', 0, 1),
    tasks,
    indicators: {
      blinks: num(ind.blinks, 'indicators.blinks', 0, 10000, { int: true }),
      longest_unprompted_eye_closure_s: num(ind.longest_unprompted_eye_closure_s, 'indicators.longest_unprompted_eye_closure_s', 0, 900),
      prolonged_unprompted_eye_closures: num(ind.prolonged_unprompted_eye_closures, 'indicators.prolonged_unprompted_eye_closures', 0, 1000, { int: true }),
      head_yaw_range_deg: num(ind.head_yaw_range_deg, 'indicators.head_yaw_range_deg', 0, 180, { nullable: true }),
      head_pitch_range_deg: num(ind.head_pitch_range_deg, 'indicators.head_pitch_range_deg', 0, 180, { nullable: true }),
      hold_still_movement: num(ind.hold_still_movement, 'indicators.hold_still_movement', 0, 1000, { nullable: true }),
      hold_still_steady: ind.hold_still_steady ?? null,
    },
    ...(v2 ? { alertness: validateAlertness(o.alertness) } : {}),
  }
}

const pct = (v) => `${Math.round(v * 100)}%`

/**
 * A plain-language, strictly factual description of an observation, for a
 * model to relay or the panel to show. Built from the numbers only.
 */
export function describe(o) {
  const done = o.tasks.filter((t) => t.completed).map((t) => t.id)
  const missed = o.tasks.filter((t) => !t.completed).map((t) => t.id)
  const parts = [
    `Face in view ${pct(o.face_visible_ratio)} of ${o.duration_s} seconds.`,
    `Tasks completed: ${done.length ? done.join(', ') : 'none'}${missed.length ? `; not completed: ${missed.join(', ')}` : ''}.`,
  ]
  const a = o.alertness
  if (a) {
    if (a.quality.grade === 'insufficient') {
      parts.push(`Natural observation: insufficient for eye measures (${a.valid_s} s of valid eye tracking; ${a.quality.reasons.join(', ')}).`)
    } else {
      parts.push(
        `Natural observation, ${a.valid_s} s of valid eye tracking at ${a.fps} frames per second (quality ${a.quality.grade}` +
          `${a.quality.reasons.length ? `: ${a.quality.reasons.join(', ')}` : ''}): eyes at least 80% closed ${pct(a.perclos_p80)} of the time (PERCLOS), ` +
          `${a.blink_rate_per_min} blinks per minute, longest closure ${a.longest_closure_s} s` +
          `${a.prolonged_closures ? `, ${a.prolonged_closures} closure${a.prolonged_closures === 1 ? '' : 's'} of 2 s or longer` : ''}.`,
      )
    }
  }
  parts.push(
    `${o.indicators.blinks} blink${o.indicators.blinks === 1 ? '' : 's'} across the whole check; longest unprompted eye closure ${o.indicators.longest_unprompted_eye_closure_s} s` +
      (o.indicators.prolonged_unprompted_eye_closures ? ` (${o.indicators.prolonged_unprompted_eye_closures} of 2 s or longer).` : '.'),
  )
  if (o.indicators.head_yaw_range_deg !== null) parts.push(`Head turn range about ${o.indicators.head_yaw_range_deg} degrees.`)
  if (o.indicators.hold_still_steady !== null) {
    parts.push(o.indicators.hold_still_steady ? 'Held still when asked.' : 'Moved noticeably while asked to hold still.')
  }
  return parts.join(' ')
}
