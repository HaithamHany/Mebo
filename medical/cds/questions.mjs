/**
 * The structured self-assessment questions. Fixed wording, fixed answer
 * types: an assistant reads these out, it does not write its own, and answers
 * are validated before any rule sees them.
 *
 * The fatigue scale is a MeBo demonstration scale, NOT a validated
 * instrument. The Samn–Perelli seven-point fatigue scale is the intended
 * replacement once its exact wording has been checked against the original
 * report; it could not be verified from an accessible source in Step 20.
 */

import { MedicalError } from '../service.mjs'

/**
 * `valid_for_minutes`: how long an answer, once given, stands in for asking
 * again (Step 23 memory). Prototype assumptions, chosen by the tense of the
 * question: "right now" symptoms last 30 minutes (one conversation);
 * "since your last check" and recent-week questions last longer. The
 * self-harm question is 0 — never reused, always asked fresh.
 */
export const QUESTIONS = {
  chest_pain: {
    valid_for_minutes: 30,
    text: 'Do you have any chest pain, pressure or discomfort right now?',
    type: 'yes_no',
  },
  short_of_breath: {
    valid_for_minutes: 30,
    text: 'Are you short of breath right now, while resting?',
    type: 'yes_no',
  },
  fainted: {
    valid_for_minutes: 360,
    text: 'Have you fainted or lost consciousness since your last check?',
    type: 'yes_no',
  },
  weak_or_lightheaded: {
    valid_for_minutes: 30,
    text: 'Do you feel weak, light-headed or faint?',
    type: 'yes_no',
  },
  radiating_pain: {
    valid_for_minutes: 30,
    text: 'Do you have pain or discomfort in your jaw, neck, back, arms or shoulders?',
    type: 'yes_no',
  },
  palpitations: {
    valid_for_minutes: 360,
    text: 'Have you noticed a racing, pounding or irregular heartbeat?',
    type: 'yes_no',
  },
  fatigue: {
    valid_for_minutes: 120,
    text:
      'On a scale of one to five, how tired do you feel right now? One is fully rested, two a little tired, ' +
      'three moderately tired, four very tired, and five exhausted.',
    type: 'scale',
    min: 1,
    max: 5,
    labels: { 1: 'fully rested', 2: 'a little tired', 3: 'moderately tired', 4: 'very tired', 5: 'exhausted' },
    note: 'MeBo demonstration scale; not a validated instrument.',
  },
  dozed_on_task: {
    valid_for_minutes: 720,
    text: 'Have you fallen asleep, or nearly fallen asleep, during a task?',
    type: 'yes_no',
  },
  schedule_shift: {
    valid_for_minutes: 1440,
    text: 'Has your sleep or work schedule shifted in the last week?',
    type: 'yes_no',
  },
  self_harm: {
    valid_for_minutes: 0,
    text: 'Have you had any thoughts of harming yourself?',
    type: 'yes_no',
  },
}

const YES = new Set(['yes', 'y', 'true', '1'])
const NO = new Set(['no', 'n', 'false', '0'])

/**
 * Normalise answers for one workflow. Unknown questions and invalid values
 * are rejected (400) rather than guessed at.
 */
export function validateAnswers(workflow, raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MedicalError(400, 'answers must be an object')
  }
  const allowed = new Set(workflow.questions.map((q) => q.id))
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === '') continue
    if (!allowed.has(key)) {
      throw new MedicalError(400, `"${key}" is not a question in the ${workflow.id} assessment. Known: ${[...allowed].join(', ')}.`)
    }
    const q = QUESTIONS[key]
    if (q.type === 'yes_no') {
      const v = String(value).trim().toLowerCase()
      if (YES.has(v) || value === true) out[key] = 'yes'
      else if (NO.has(v) || value === false) out[key] = 'no'
      else throw new MedicalError(400, `"${key}" must be yes or no`)
    } else if (q.type === 'scale') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < q.min || n > q.max) {
        throw new MedicalError(400, `"${key}" must be a whole number from ${q.min} to ${q.max}`)
      }
      out[key] = n
    }
  }
  return out
}
