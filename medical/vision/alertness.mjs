/**
 * The observational alertness summary (Step 26B).
 *
 * Puts the camera's natural-observation measures (PERCLOS, blinks, eye
 * closures, measurement quality) beside what MeBo already knows about the
 * crew member — recorded sleep history, their own fatigue answers, the last
 * sleep and fatigue assessment, open concerns and mission context — and turns
 * them into plain explanations and suggested next steps.
 *
 * What it is not: an assessment. It sets no level, computes no combined score
 * and makes no fitness-for-duty judgement. The sleep and fatigue assessment
 * (medical/cds/sleep-fatigue.mjs, the rules engine) stays authoritative for
 * escalation; the only clinical next step this ever suggests is to run that
 * assessment, whose rules then decide. Camera measures are research measures
 * (docs/alertness-assessment.md) and are described as such every time.
 *
 * Pure functions over data gathered by medical/workflows.mjs, so they can be
 * tested directly and reused by any model or none.
 */

import { QUESTIONS } from '../cds/questions.mjs'

/**
 * A prototype follow-up cue, not a threshold: at or above this PERCLOS (with
 * usable quality), MeBo offers the sleep and fatigue check first. Published
 * drowsiness studies use different PERCLOS cut-offs for different settings
 * (Abe 2023); none is validated for this camera, software or spaceflight, so
 * this value only orders the suggestions. It never sets or changes a level.
 */
export const PROTOTYPE_CUE = { PERCLOS: 0.15, PROLONGED_CLOSURES: 1 }

export const AUTHORITY =
  'The sleep and fatigue assessment (the rules engine) is authoritative for any escalation. This summary only ' +
  'gathers observations: it sets no level, gives no diagnosis, and does not judge fitness for duty — that ' +
  'decision belongs to the crew medical officer and the flight surgeon.'

export const LIMITATIONS = [
  'PERCLOS and blink measures are research measures associated with drowsiness in laboratory and driving studies; they are not validated for this webcam, this software, this population or spaceflight.',
  'Eye aspect ratio comes from estimated landmarks; glasses, glare, lighting, head angle and eye shape all affect it. The 80%-closed reference is calibrated per session, and is less reliable without the instructed eye closure.',
  'A short observation (about one minute) gives an imprecise rate; blinking varies a great deal between people and situations.',
  'In MeBo\'s browser validation, sustained eye closures were measured close to the truth, but brief blinks (0.2–0.3 s) were mostly missed; the blink rate is therefore not validated and may undercount.',
  'With glasses and glare, or an eye covered, MediaPipe did not register closed eyes; when the instructed eye closure is not seen, no closure measure is reported.',
  'Looking down, reading, screen glare or dry eyes change these measures without any change in alertness.',
  'Camera measures alone cannot establish a diagnosis, determine fitness for duty or change an escalation level.',
]

const SAY_REASON = {
  no_observation: { why: 'the ordinary-looking part of the check did not run', fix: '' },
  short_observation: { why: 'there was not enough time with your eyes clearly in view', fix: 'Please keep your face in view for the whole observation.' },
  below_window: { why: 'part of the observation could not be used', fix: '' },
  very_low_frame_rate: { why: 'the camera ran too slowly to measure blinks', fix: 'Closing other programs may help.' },
  low_frame_rate: { why: 'the camera ran slowly, so short blinks may have been missed', fix: 'Closing other programs may help.' },
  missing_frames: { why: 'your face was out of view or hidden for part of the time', fix: 'Please keep your whole face in view.' },
  head_turned: { why: 'your head was often turned away from the camera', fix: 'Please face the camera.' },
  face_too_small: { why: 'your face was small in the picture', fix: 'Please sit a little closer to the camera.' },
  eye_asymmetry: { why: 'one eye often looked different from the other, which glare, glasses or something covering an eye can cause', fix: 'If you wear glasses, reducing glare may help.' },
  no_closed_calibration: { why: 'I could not calibrate with your eyes closed', fix: 'Please close your eyes fully when I ask.' },
  closure_not_detected: {
    why: 'I could not see your eyes close when I asked, so I cannot measure eye closures reliably here',
    fix: 'Glasses, glare or something in front of the eyes can cause this. Removing glasses or reducing glare may help.',
  },
  low_agreement: { why: 'my two ways of measuring your eyes did not agree well', fix: '' },
  too_dark: { why: 'the light on your face was dim', fix: 'More light on your face would help.' },
  too_bright: { why: 'the light on your face was very bright', fix: 'Softer light would help.' },
  illumination_changed: { why: 'the lighting changed during the observation', fix: 'Steady lighting would help.' },
}

/**
 * People blink roughly 17 times a minute at rest, with wide variation
 * (Bentivoglio et al. 1997). A measured rate under 2 a minute says more about
 * the measurement — quick blinks missed — than about the person, so it is not
 * spoken as a rate. A prototype plausibility floor, not a clinical value.
 */
const MIN_PLAUSIBLE_BLINKS_PER_MIN = 2
export const plausibleBlinkRate = (a) => a.blink_rate_per_min !== null && a.blink_rate_per_min >= MIN_PLAUSIBLE_BLINKS_PER_MIN

const list = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)
const pct = (v) => `${Math.round(v * 100)} percent`

/** Quality, in words: why it is less than good, and what would help. */
export function qualityInWords(a) {
  const reasons = a?.quality?.reasons ?? ['no_observation']
  const why = list(reasons.map((r) => SAY_REASON[r]?.why).filter(Boolean))
  const fixes = [...new Set(reasons.map((r) => SAY_REASON[r]?.fix).filter(Boolean))]
  return { why, advice: fixes.slice(0, 2).join(' ') }
}

/**
 * What MeBo says about a camera observation: what was measured, how good the
 * measurement was, and its limits. Built from the numbers only; it never
 * names a condition.
 */
export function explain(observation) {
  const a = observation?.alertness
  if (!a) return 'This camera check did not include the ordinary-looking observation, so I have no eye measurements from it.'
  const q = qualityInWords(a)
  if (a.quality.grade === 'insufficient') {
    return `I could not measure your eyes reliably this time, because ${q.why}. ${q.advice}`.trim()
  }
  const parts = [
    `Over ${Math.round(a.valid_s)} seconds of ordinary looking, your eyes were at least eighty percent closed about ${pct(a.perclos_p80)} of the time` +
      (plausibleBlinkRate(a)
        ? `, and you blinked about ${Math.round(a.blink_rate_per_min)} times a minute.`
        : '. I could not count your blinks reliably.'),
    a.longest_closure_s >= 1
      ? `Your longest eye closure was ${a.longest_closure_s.toFixed(1)} seconds.`
      : 'I did not see any long eye closures.',
    a.quality.grade === 'good' ? 'The measurement quality was good.' : `The measurement quality was limited, because ${q.why}.`,
    'Blink counting is not yet validated on this system, and it can miss quick blinks.',
    'These are research measures. They are not validated for this camera or for spaceflight, and on their own they cannot show tiredness, a diagnosis, or whether you are fit for duty.',
  ]
  return parts.join(' ')
}

const OFFER_SLEEP_CHECK =
  'Would you like me to run the sleep and fatigue check? It asks a few short questions, and its rules decide what happens next.'

/**
 * Suggested next steps, most relevant first. Never a clinical instruction:
 * the strongest is to run the rules-based sleep and fatigue check.
 *
 * @param f.observation  latest camera observation (validated), or null
 * @param f.selfReport   { fatigue: {value, age_minutes}|null, dozed_on_task: {value, age_minutes}|null }
 * @param f.lastAssessment last sleep_fatigue assessment from memory, or null
 * @param f.openConcerns open sleep_fatigue concerns from memory
 * @param f.nowMs        the service clock
 */
export function followUps({ observation, selfReport, lastAssessment, openConcerns = [], nowMs }) {
  const out = []
  const a = observation?.alertness ?? null
  const usable = a && a.quality.grade !== 'insufficient'
  const cue = usable && (a.perclos_p80 >= PROTOTYPE_CUE.PERCLOS || a.prolonged_closures >= PROTOTYPE_CUE.PROLONGED_CLOSURES)
  const reportedTired = (selfReport?.fatigue?.value ?? 0) >= 4 || selfReport?.dozed_on_task?.value === 'yes'
  const checkedRecently = lastAssessment && nowMs - Date.parse(lastAssessment.at) < 24 * 3600_000

  const reasons = [
    ...(cue ? ['camera measures at or above the prototype follow-up cue'] : []),
    ...(reportedTired ? ['the crew member reported marked tiredness or dozing on task'] : []),
    ...(!checkedRecently ? ['no sleep and fatigue assessment in the last 24 hours'] : []),
  ]
  // Either way the next step is the same rules-based check; one offer only.
  if (openConcerns.length) {
    out.push({
      kind: 'offer_sleep_fatigue_check',
      prompt: 'Your last sleep and fatigue check found something to follow up. Would you like me to repeat it now? Its rules decide what happens next.',
      because: [...openConcerns.map((c) => `open concern: ${c.title}`), ...reasons],
    })
  } else if (reasons.length) {
    out.push({ kind: 'offer_sleep_fatigue_check', prompt: OFFER_SLEEP_CHECK, because: reasons })
  }
  if (!out.some((x) => x.kind === 'offer_sleep_fatigue_check') && !selfReport?.fatigue) {
    out.push({ kind: 'ask_self_report', prompt: QUESTIONS.fatigue.text, because: ['no recent self-rated tiredness'] })
  }
  if (a && a.quality.grade !== 'good') {
    const q = qualityInWords(a)
    out.push({
      kind: 'repeat_camera_check',
      prompt: `If you like, we can repeat the camera check later. ${q.advice}`.trim(),
      because: a.quality.reasons,
    })
  }
  if (!out.length) {
    out.push({
      kind: 'none',
      prompt: 'If you feel tired at any point, tell me, and I can run the sleep and fatigue check.',
      because: [],
    })
  }
  // A camera cue puts the offer first: the rules engine is the one that decides.
  if (cue) out.sort((x, y) => (y.kind === 'offer_sleep_fatigue_check') - (x.kind === 'offer_sleep_fatigue_check'))
  return out
}

/**
 * Factual statements that put the camera measures beside the rest of the
 * record. Each says where it comes from; none combines them into a judgement.
 */
export function contextStatements({ observation, observationAgeMin, sleep, selfReport, lastAssessment, mission }) {
  const out = []
  const a = observation?.alertness
  if (a) {
    out.push(
      a.quality.grade === 'insufficient'
        ? `Camera (${Math.round(observationAgeMin)} min ago): eye measures insufficient (${a.quality.reasons.join(', ')}).`
        : `Camera (${Math.round(observationAgeMin)} min ago, quality ${a.quality.grade}): PERCLOS ${pct(a.perclos_p80)}, ` +
            `${plausibleBlinkRate(a) ? `${a.blink_rate_per_min} blinks per minute (not validated)` : 'blinks not reliably counted'}, ` +
            `longest closure ${a.longest_closure_s} s over ${a.valid_s} s.`,
    )
  } else {
    out.push('Camera: no natural-observation measures on record.')
  }
  if (sleep?.latest) {
    out.push(
      `Sleep (medical database, synthetic): last recorded ${sleep.latest.value} ${sleep.unit}` +
        `${sleep.mean_7_days !== null ? `; 7-day mean ${Number(sleep.mean_7_days).toFixed(1)} ${sleep.unit}` : ''}` +
        `${sleep.baseline_mean !== null ? `; pre-flight baseline ${sleep.baseline_mean} ${sleep.unit}` : ''}.`,
    )
  } else {
    out.push('Sleep (medical database): no recent record.')
  }
  const f = selfReport?.fatigue
  out.push(
    f
      ? `Self-rated tiredness: ${f.value} of 5 (${QUESTIONS.fatigue.labels[f.value] ?? '—'}), ${Math.round(f.age_minutes)} min ago; a demonstration scale, not a validated instrument.`
      : 'Self-rated tiredness: not asked recently.',
  )
  if (selfReport?.dozed_on_task) {
    out.push(`Fallen asleep or nearly, during a task: ${selfReport.dozed_on_task.value} (${Math.round(selfReport.dozed_on_task.age_minutes)} min ago).`)
  }
  out.push(
    lastAssessment
      ? `Last sleep and fatigue assessment (rules engine): ${String(lastAssessment.level).toUpperCase()}, ${lastAssessment.status}, at ${lastAssessment.at}.`
      : 'Sleep and fatigue assessment (rules engine): none on record.',
  )
  if (mission) out.push(`Mission: ${mission.name}, day ${mission.mission_day ?? '—'} (synthetic scenario).`)
  return out
}
