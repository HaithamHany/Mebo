/**
 * The sleep and fatigue interview after a camera check (Step 26C): the pure
 * parts — reading a spoken answer, and wording what MeBo says.
 *
 * No browser or app imports, so it is tested directly
 * (test/camera-followup.test.mjs). No language model: answers are read by
 * fixed rules, and anything unclear is asked again or left unanswered —
 * never guessed. The questions and their wording come from the rules engine
 * (begin_medical_check), and the assessment is the rules engine's own
 * (assess_sleep_fatigue); this file decides nothing clinical.
 */

export type Question = {
  id: string
  text: string
  type: 'yes_no' | 'scale'
  min?: number
  max?: number
  labels?: Record<string, string>
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `

/** "I don't know", "maybe": not an answer. Asked again rather than read as yes or no. */
const UNSURE = / (not sure|unsure|don't know|dont know|do not know|maybe|i guess|no idea|perhaps) /

const STRONG_YES = / (yes|yeah|yep|yup|correct|affirmative|absolutely|definitely) /
const WEAK_YES = / (i have|i did|i do|it has|i think so) /
const STRONG_NO = / (no|nope|nah|negative|none) /
const NEGATION = / (not|never|haven't|havent|hasn't|hasnt|has not|didn't|didnt|don't|dont) /

/**
 * yes, no, or null when unclear (both, neither, or unsure). A negation
 * cancels the weak "yes" phrases: "I have not" is no, "I have" is yes.
 */
export function parseYesNo(text: string): 'yes' | 'no' | null {
  const t = norm(text)
  if (UNSURE.test(t)) return null
  const negated = NEGATION.test(t)
  const y = STRONG_YES.test(t) || (WEAK_YES.test(t) && !negated)
  const n = STRONG_NO.test(t) || negated
  if (y === n) return null
  return y ? 'yes' : 'no'
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 }

/**
 * A number on the question's scale, from digits, number words or the
 * scale's own labels ("very tired"). Null when there is none, or more than
 * one — the echo of the question itself lists every option, so several
 * values is never an answer.
 */
export function parseScale(text: string, q: Pick<Question, 'min' | 'max' | 'labels'>): number | null {
  if (UNSURE.test(norm(text))) return null
  const min = q.min ?? 1
  const max = q.max ?? 5
  const found = new Set<number>()
  const t = norm(text)
  for (const m of t.matchAll(/ (\d+) /g)) found.add(Number(m[1]))
  for (const [w, n] of Object.entries(WORDS)) if (t.includes(` ${w} `)) found.add(n)
  for (const [n, label] of Object.entries(q.labels ?? {})) {
    if (t.includes(` ${label.toLowerCase()} `)) found.add(Number(n))
  }
  // "very tired" contains "tired" but not "a little tired"; "moderately tired" is distinct.
  const values = [...found].filter((n) => n >= min && n <= max)
  return found.size === 1 && values.length === 1 ? values[0] : null
}

/** The person would rather not answer this one. */
export function isSkip(text: string): boolean {
  return / (skip|pass|rather not|prefer not|next question|move on) /.test(norm(text))
}

/** May MeBo ask the questions now? yes, no, or null when unclear. */
export function parseConsent(text: string): 'yes' | 'no' | null {
  const t = norm(text)
  if (/ (not now|later|no thanks|no thank you|not right now|skip|stop|cancel) /.test(t)) return 'no'
  if (/ (go ahead|sure|okay|ok|fine|all right|alright|of course|please do|let's go|lets go) /.test(t)) return 'yes'
  return parseYesNo(text)
}

/** Read one answer to one question. */
export function parseAnswer(q: Question, text: string): string | number | null {
  return q.type === 'scale' ? parseScale(text, q) : parseYesNo(text)
}

// ---------------------------------------------------------------------------
// What MeBo says
// ---------------------------------------------------------------------------

export const CONSENT_QUESTION =
  'Now I would like to ask you a few short questions about your sleep and how tired you feel. Is that all right?'

/**
 * Said before the questions when the camera could not contribute: no face,
 * a refused camera, or insufficient eye-measurement quality. Missing
 * observations are never reassurance.
 */
export function cameraGapNote(reason: 'insufficient' | 'no_face' | 'denied' | 'error'): string {
  const why = {
    insufficient: 'I could not measure your eyes reliably with the camera this time',
    no_face: 'I could not see your face with the camera',
    denied: 'I could not use the camera',
    error: 'the camera check did not work',
  }[reason]
  return `${why}, so the camera adds nothing to this check. That does not mean everything is fine. The questions will still tell us how you are.`
}

export type AssessmentLike = {
  status: string
  level: string
  summary: string
  evidence: { title: string; level: string }[]
  missing: { label: string; required: boolean }[]
  next_assessments?: { text: string }[]
  escalation: { level: string; guidance: string; incomplete?: string }
}

/**
 * What MeBo says about the assessment: the rules engine's escalation
 * guidance first and verbatim, then the main findings by name, what is
 * missing, and that the camera did not change the result. With a
 * camera-supported fatigue concern (Step 26D), its own spoken explanation
 * follows — after the guidance, which it never replaces.
 */
export function spokenResult(r: AssessmentLike, concernSpoken?: string | null): string {
  const parts = ['Here is the result of your sleep and fatigue check.', r.escalation.guidance]
  const main = r.evidence.filter((e) => e.level !== 'monitor' && e.level !== 'none').map((e) => e.title.toLowerCase())
  if (main.length) parts.push(`The main findings are: ${main.slice(0, 4).join('; ')}.`)
  if (r.status === 'incomplete') {
    const missing = r.missing.filter((m) => m.required).map((m) => m.label.toLowerCase())
    if (missing.length) parts.push(`Some answers are missing: ${missing.join('; ')}.`)
    if (r.escalation.incomplete) parts.push(r.escalation.incomplete)
  }
  parts.push(
    concernSpoken
      ? 'The camera measures did not change that result.'
      : 'The camera measures were supplementary, and they did not change this result.',
  )
  if (concernSpoken) parts.push(concernSpoken)
  return parts.join(' ')
}

/** A one-line note for the crew member's memory (at most 500 characters). */
export function conversationNote(o: {
  cameraQuality: string
  observationId: string | null
  declined: boolean
  result: Pick<AssessmentLike, 'level' | 'status'> & { trace?: { assessment_id?: string } } | null
  concern?: { level: string; raised_by_camera: boolean } | null
}): string {
  const cam = `Camera check (${o.cameraQuality}${o.observationId ? `, ${o.observationId}` : ''})`
  const text = o.declined
    ? `${cam}; declined the sleep and fatigue questions afterwards, so no assessment was made.`
    : o.result
      ? `${cam} followed by the sleep and fatigue check: ${o.result.level.toUpperCase()}, ${o.result.status}` +
        `${o.result.trace?.assessment_id ? ` (${o.result.trace.assessment_id})` : ''}` +
        `${o.concern ? `; camera-supported fatigue concern ${o.concern.level}${o.concern.raised_by_camera ? ' (raised by the camera)' : ''}` : ''}.`
      : `${cam}; the sleep and fatigue check did not finish.`
  return text.slice(0, 500)
}
