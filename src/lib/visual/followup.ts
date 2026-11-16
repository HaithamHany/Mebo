import { create } from 'zustand'
import { BRIDGE_HTTP_URL } from '../../config'
import {
  CONSENT_QUESTION,
  cameraGapNote,
  conversationNote,
  isSkip,
  parseAnswer,
  parseConsent,
  spokenResult,
  type AssessmentLike,
  type Question,
} from './interview'

/**
 * From camera check to health assessment (Step 26C).
 *
 * When a camera check ends, MeBo continues into the existing sleep and
 * fatigue workflow, entirely through the local medical tools:
 *
 *   begin_medical_check   → the questions still to ask (remembered answers
 *                           removed), from the rules engine, in its wording
 *   (MeBo asks them)       → answers by voice or on screen, read by fixed
 *                           rules (interview.ts), never guessed
 *   assess_sleep_fatigue  → the rules engine's assessment, unchanged; it
 *                           files the result and answers in memory
 *   assess_fatigue_concern → the camera-supported fatigue concern (Step 26D):
 *                           the assessment's level as a floor, raised — never
 *                           lowered — by a reliable camera observation
 *   /crew/:id/alertness   → camera measures beside sleep history, for the
 *                           combined summary
 *   record_crew_memory    → a one-line note of what happened
 *
 * No language model is involved, so the same flow works with Claude now and
 * with an offline model later, or with none. Camera measures are never sent
 * to the assessment; they reach only the separate fatigue concern, and only
 * when reliable. When the camera could not contribute, MeBo says so and that it
 * is not reassurance, and the questions go ahead.
 */

export type FollowStatus = 'idle' | 'consent' | 'asking' | 'camera' | 'assessing' | 'done' | 'declined' | 'stopped' | 'error'

export type Assessment = AssessmentLike & {
  workflow: string
  trace: { assessment_id: string }
  answers_from_memory?: Record<string, unknown>
}

/** The camera-supported fatigue concern, as medical/vision/fatigue-concern.mjs returns it. */
export type FatigueConcern = {
  concern_id: string
  at: string
  level: 'low' | 'moderate' | 'high' | 'indeterminate'
  rules_floor: 'low' | 'moderate' | 'high' | 'indeterminate'
  raised_by_camera: boolean
  rules_assessment: { assessment_id: string; level: string; status: string } | null
  camera: {
    status: 'used' | 'missing' | 'stale' | 'rejected'
    reasons: string[]
    observation_id?: string | null
    quality: string | null
    perclos_p80: number | null
    prolonged_closures: number | null
    longest_closure_s: number | null
  }
  contributors: { source: string; via?: string; indicator: string; value?: string; threshold?: string; effect: string; note?: string; basis: string }[]
  conflicts: string[]
  explanation: string
  spoken: string
  references: { id: string; kind: string; citation: string; url?: string }[]
}

/** What the bridge's camera tool returns about the follow-on assessment. */
export type FollowOutcome = {
  declined: boolean
  completed: boolean
  level: string | null
  status: string | null
  summary: string | null
  guidance: string | null
  incomplete_note: string | null
  missing: string[]
  assessment_id: string | null
  camera_note: string | null
  fatigue_concern: {
    level: string
    raised_by_camera: boolean
    camera_status: string
    spoken: string
    explanation: string
  } | null
}

type State = {
  status: FollowStatus
  crewId: string
  observationId: string | null
  cameraQuality: string
  /** Said and shown when the camera could not contribute. */
  cameraNote: string
  questions: Question[]
  index: number
  answers: Record<string, string | number>
  skipped: string[]
  /** What MeBo has just asked, shown with the answer buttons. */
  prompt: string
  /** Waiting for an answer to `prompt`; the voice loop routes speech here. */
  awaiting: boolean
  kind: 'consent' | 'yes_no' | 'scale'
  heard: string
  result: Assessment | null
  /** The camera-supported fatigue concern built on `result` (Step 26D). */
  concern: FatigueConcern | null
  /** The observational summary (camera beside sleep history), for display. */
  context: { context: string[]; nasa_background: { citation: string; passage_id: string }[] } | null
  error: string
  at: string
  /** An interview interrupted (reload, Stop) that can be resumed. */
  resumable: Saved | null
}

const blank = {
  status: 'idle' as FollowStatus,
  crewId: '',
  observationId: null,
  cameraQuality: '',
  cameraNote: '',
  questions: [],
  index: -1,
  answers: {},
  skipped: [],
  prompt: '',
  awaiting: false,
  kind: 'consent' as const,
  heard: '',
  result: null,
  concern: null,
  context: null,
  error: '',
  at: '',
}

export const useFollowUp = create<State>(() => ({ ...blank, resumable: null }))

const ACTIVE: FollowStatus[] = ['consent', 'asking', 'assessing']
export const followUpActive = () => ACTIVE.includes(useFollowUp.getState().status)
export const followUpAwaiting = () => useFollowUp.getState().awaiting

// ---------------------------------------------------------------------------
// Progress kept across a reload
// ---------------------------------------------------------------------------

/**
 * Answers given so far, kept in this browser for 30 minutes so a reload or a
 * Stop does not throw them away. Kept only locally, cleared when the
 * assessment is filed or declined. 30 minutes is the shortest validity
 * window of the questions MeBo asks most ("right now" symptoms).
 */
const SAVE_KEY = 'mebo.followup'
const SAVE_TTL_MS = 30 * 60_000

type Saved = {
  crewId: string
  observationId: string | null
  cameraQuality: string
  answers: Record<string, string | number>
  consented: boolean
  savedAt: number
}

function save(s: Omit<Saved, 'savedAt'>) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...s, savedAt: Date.now() }))
  } catch {
    /* private mode: the interview simply cannot be resumed */
  }
}

function clearSaved() {
  try {
    localStorage.removeItem(SAVE_KEY)
  } catch {
    /* ignore */
  }
  useFollowUp.setState({ resumable: null })
}

/** Read an interrupted interview back after a reload. */
export function loadSavedFollowUp(): Saved | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null
    if (!s || Date.now() - s.savedAt > SAVE_TTL_MS) {
      localStorage.removeItem(SAVE_KEY)
      return null
    }
    if (!followUpActive()) useFollowUp.setState({ resumable: s })
    return s
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The local medical tools
// ---------------------------------------------------------------------------

async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/medical/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body as T
}

// ---------------------------------------------------------------------------
// Asking and listening
// ---------------------------------------------------------------------------

let speak: (text: string) => Promise<void> = async () => {}
export function configureFollowUp(opts: { say: (text: string) => Promise<void> }) {
  speak = opts.say
}

/** How long to wait for an answer before asking once more. */
const ANSWER_WAIT_MS = 20_000

let pendingAnswer: ((text: string | null) => void) | null = null
let ctrl: AbortController | null = null

/**
 * Speech from the voice loop. Returns true when the interview took it, so
 * the app does not also send it to the assistant as a new question.
 */
export function deliverAnswer(text: string): boolean {
  if (!followUpActive()) return false
  if (/\b(stop|cancel)\b/i.test(text) && !useFollowUp.getState().awaiting) {
    cancelFollowUp()
    return true
  }
  if (pendingAnswer) {
    useFollowUp.setState({ heard: text })
    const resolve = pendingAnswer
    pendingAnswer = null
    resolve(text)
  }
  // Speech while MeBo is still asking is not an answer, and not a new turn.
  return true
}

/** An answer chosen on screen. Same path as a spoken one. */
export function answerWith(value: string) {
  if (!pendingAnswer) return
  const resolve = pendingAnswer
  pendingAnswer = null
  useFollowUp.setState({ heard: value })
  resolve(value)
}

export function cancelFollowUp() {
  ctrl?.abort()
  if (pendingAnswer) {
    const resolve = pendingAnswer
    pendingAnswer = null
    resolve(null)
  }
}

class Stopped extends Error {}

/**
 * Say `prompt`, then wait for an answer that `read` understands. Unclear or
 * no answer: ask once more; still unclear: null. Only listens once MeBo has
 * finished speaking, so the echo of its own question is never an answer.
 */
async function ask<T>(prompt: string, read: (t: string) => T | null, kind: State['kind'], retry: string): Promise<T | 'skip' | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (ctrl?.signal.aborted) throw new Stopped()
    useFollowUp.setState({ prompt, kind, heard: '', awaiting: false })
    await speak(attempt === 0 ? prompt : `${retry} ${prompt}`)
    if (ctrl?.signal.aborted) throw new Stopped()
    useFollowUp.setState({ awaiting: true })
    const heard = await new Promise<string | null>((resolve) => {
      pendingAnswer = resolve
      setTimeout(() => {
        if (pendingAnswer === resolve) {
          pendingAnswer = null
          resolve(null)
        }
      }, ANSWER_WAIT_MS)
    })
    useFollowUp.setState({ awaiting: false })
    if (ctrl?.signal.aborted) throw new Stopped()
    if (heard === null) continue
    if (kind !== 'consent' && isSkip(heard)) return 'skip'
    const value = read(heard)
    if (value !== null) return value
  }
  return null
}

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

export type CameraOutcome = {
  /** good | limited | insufficient | no_face | denied | error | none */
  quality: string
  observationId: string | null
}

const GAP: Record<string, 'insufficient' | 'no_face' | 'denied' | 'error'> = {
  insufficient: 'insufficient',
  none: 'insufficient',
  no_face: 'no_face',
  denied: 'denied',
  error: 'error',
}

function outcomeOf(s: State): FollowOutcome {
  const r = s.result
  return {
    declined: s.status === 'declined',
    completed: s.status === 'done',
    level: r?.level ?? null,
    status: r?.status ?? null,
    summary: r?.summary ?? null,
    guidance: r?.escalation.guidance ?? null,
    incomplete_note: r?.status === 'incomplete' ? (r.escalation.incomplete ?? null) : null,
    missing: (r?.missing ?? []).filter((m) => m.required).map((m) => m.label),
    assessment_id: r?.trace.assessment_id ?? null,
    camera_note: s.cameraNote || null,
    fatigue_concern: s.concern
      ? {
          level: s.concern.level,
          raised_by_camera: s.concern.raised_by_camera,
          camera_status: s.concern.camera.status,
          spoken: s.concern.spoken,
          explanation: s.concern.explanation,
        }
      : null,
  }
}

/**
 * Run the sleep and fatigue follow-up for one crew member after a camera
 * check (or resume an interrupted one). Never throws.
 */
export async function runFollowUp(
  crewId: string,
  camera: CameraOutcome,
  opts: {
    resume?: boolean
    /**
     * The guided health check (Step 27): starting it was the consent, so the
     * consent question is skipped, and `beforeAssess` runs between the
     * questions and the assessment (the optional camera check).
     */
    guided?: { beforeAssess: () => Promise<CameraOutcome | null> }
  } = {},
): Promise<FollowOutcome> {
  if (followUpActive()) return outcomeOf(useFollowUp.getState())
  ctrl = new AbortController()
  const set = useFollowUp.setState
  const saved = opts.resume ? loadSavedFollowUp() : null
  const answers: Record<string, string | number> = saved?.crewId === crewId ? { ...saved.answers } : {}
  set({
    ...blank,
    status: 'consent',
    crewId,
    observationId: saved?.observationId ?? camera.observationId,
    cameraQuality: saved?.cameraQuality ?? camera.quality,
    answers,
    resumable: null,
  })
  const quality = useFollowUp.getState().cameraQuality
  const observationId = useFollowUp.getState().observationId
  const keep = (consented: boolean) => save({ crewId, observationId, cameraQuality: quality, answers, consented })

  try {
    // The camera could not contribute: say so, and that it is not reassurance.
    if (!saved && GAP[camera.quality]) {
      const note = cameraGapNote(GAP[camera.quality])
      set({ cameraNote: note })
      await speak(note)
    }

    const begun = await tool<{ questions_to_ask: Question[]; already_answered: Record<string, unknown> }>('begin_medical_check', {
      crew_id: crewId,
      workflow: 'sleep_fatigue',
    })
    const questions = begun.questions_to_ask.filter((q) => !(q.id in answers))
    set({ questions })

    if (questions.length && !saved?.consented && !opts.guided) {
      keep(false)
      const consent = await ask(CONSENT_QUESTION, parseConsent, 'consent', 'I did not catch that.')
      if (consent !== 'yes') {
        // Declined, or no clear answer: no assessment. Said plainly, not as reassurance.
        set({ status: 'declined', at: new Date().toISOString(), prompt: '' })
        await tool('record_crew_memory', {
          crew_id: crewId,
          kind: 'conversation_note',
          text: conversationNote({ cameraQuality: quality, observationId, declined: true, result: null }),
        }).catch(() => {})
        clearSaved()
        await speak(
          'All right. I will not ask the questions now. Without them I cannot assess your sleep and fatigue, so that is not a sign that everything is fine. Tell me whenever you feel tired.',
        )
        return outcomeOf(useFollowUp.getState())
      }
    } else if (!questions.length) {
      await speak('I already have your recent answers, so I will run the sleep and fatigue check now.')
    }

    set({ status: 'asking' })
    keep(true)
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      set({ index: i })
      const answer = await ask(q.text, (t) => parseAnswer(q, t), q.type, 'I did not catch that.')
      if (answer === null || answer === 'skip') {
        set((s) => ({ skipped: [...s.skipped, q.id] }))
      } else {
        answers[q.id] = answer
        set({ answers: { ...answers } })
        keep(true)
      }
    }

    if (opts.guided) {
      set({ status: 'camera', prompt: '', index: -1, awaiting: false })
      const cam = await opts.guided.beforeAssess()
      if (ctrl?.signal.aborted) throw new Stopped()
      if (cam) set({ observationId: cam.observationId, cameraQuality: cam.quality })
    }

    // The rules engine decides; nothing from the camera is passed to it.
    set({ status: 'assessing', prompt: '', index: -1 })
    const result = await tool<Assessment>('assess_sleep_fatigue', { crew_id: crewId, answers })
    // Built on this assessment, never feeding back into it. Optional: without
    // it the rules engine's result stands on its own.
    // Only this check's own camera observation counts: none if it had no
    // camera, never an older one.
    const concern = await tool<FatigueConcern>('assess_fatigue_concern', {
      crew_id: crewId,
      assessment_id: result.trace.assessment_id,
      observation_id: useFollowUp.getState().observationId ?? 'none',
    }).catch(() => null)
    const context = await fetch(`${BRIDGE_HTTP_URL}/medical/crew/${encodeURIComponent(crewId)}/alertness`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    await tool('record_crew_memory', {
      crew_id: crewId,
      kind: 'conversation_note',
      text: conversationNote({ cameraQuality: quality, observationId, declined: false, result, concern }),
    }).catch(() => {})
    clearSaved()
    set({ status: 'done', result, concern, context, at: new Date().toISOString() })
    await speak(spokenResult(result, concern?.spoken))
    return outcomeOf(useFollowUp.getState())
  } catch (err) {
    if (err instanceof Stopped || ctrl?.signal.aborted) {
      // Answers so far stay saved for a while; the card offers to resume.
      set({ status: 'stopped', awaiting: false, prompt: '', at: new Date().toISOString() })
      loadSavedFollowUp()
    } else {
      set({ status: 'error', awaiting: false, error: String((err as Error)?.message ?? err), at: new Date().toISOString() })
    }
    return outcomeOf(useFollowUp.getState())
  } finally {
    pendingAnswer = null
    ctrl = null
  }
}

/**
 * After a reload: the latest sleep and fatigue assessment for the crew
 * member of the latest camera check, if it was made after that check — the
 * pair the side card shows. Read-only.
 */
export async function restoreLinkedAssessment(crewId: string, observedAt: string): Promise<void> {
  if (followUpActive() || useFollowUp.getState().result) return
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/medical/crew/${encodeURIComponent(crewId)}/alertness`)
    if (!res.ok) return
    const sum = await res.json()
    const a = sum.last_rule_assessment
    if (!a || a.at < observedAt) return
    const latest = await fetch(`${BRIDGE_HTTP_URL}/medical/crew/${encodeURIComponent(crewId)}/fatigue-concern`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    const concern: FatigueConcern | null =
      latest?.latest?.rules_assessment?.assessment_id === a.assessment_id ? latest.latest : null
    useFollowUp.setState({
      status: 'done',
      crewId,
      at: a.at,
      context: sum,
      concern,
      result: {
        workflow: 'sleep_fatigue',
        status: a.status,
        level: a.level,
        summary: a.summary,
        evidence: [],
        missing: [],
        escalation: { level: a.level, guidance: '' },
        trace: { assessment_id: a.assessment_id },
      },
    })
  } catch {
    /* optional */
  }
}
