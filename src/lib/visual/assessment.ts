import { create } from 'zustand'
import { BRIDGE_HTTP_URL } from '../../config'
import { startFace, stopFace } from './face'
import {
  followUpActive,
  loadSavedFollowUp,
  restoreLinkedAssessment,
  runFollowUp,
  useFollowUp,
  type CameraOutcome,
  type FollowOutcome,
} from './followup'
import {
  ALERTNESS,
  OBSERVATION_NOTICE,
  TASKS,
  clampWindow,
  instructionFor,
  spokenDuration,
  summarize,
  taskOver,
  taskProgress,
  type Frame,
  type Observation,
  type TaskId,
  type TaskWindow,
} from './observe'

// ---------------------------------------------------------------------------
// The natural-observation window
// ---------------------------------------------------------------------------

const WINDOW_KEY = 'mebo.alertness.window'

/**
 * How long the natural-observation task watches, in seconds (20 to 180).
 * VITE_ALERTNESS_WINDOW_S sets the default (60, the published PERCLOS
 * window); `__mebo.visual.setWindow(90)` overrides it in this browser.
 */
export function observationWindow(): number {
  try {
    const stored = Number(localStorage.getItem(WINDOW_KEY))
    if (stored) return clampWindow(stored)
  } catch {
    /* private mode */
  }
  const env = Number(import.meta.env.VITE_ALERTNESS_WINDOW_S)
  return env ? clampWindow(env) : ALERTNESS.WINDOW_S
}

export function setObservationWindow(seconds: number | null): number {
  try {
    if (seconds === null) localStorage.removeItem(WINDOW_KEY)
    else localStorage.setItem(WINDOW_KEY, String(clampWindow(seconds)))
  } catch {
    /* private mode */
  }
  return observationWindow()
}

/**
 * The guided camera assessment.
 *
 * MeBo explains what it is about to observe, asks for the camera, talks the
 * crew member through four simple tasks, and files a numeric summary. Runs
 * from the Camera Assessment panel or when MeBo asks for it (the bridge's
 * request_visual_observation tool) — either way the same code, with no
 * language model involved: the tasks, their wording and the judging of each
 * are fixed here and in observe.ts.
 *
 * Privacy: frames are analysed in memory and dropped (face.ts). The only thing
 * that leaves the browser is the summary — counts, ranges and task completion
 * — posted to the local bridge, which validates it and keeps it in this
 * crew member's memory file. No image, video or landmark list is uploaded or
 * stored, and nothing is recorded.
 */

export const introFor = (windowS: number) =>
  `I will observe your face with the camera for a short while, including ${spokenDuration(windowS)} of ordinary looking. ` +
  'This is an observation only. It is not a diagnosis, and it cannot tell whether you are fit for duty. ' +
  'The video stays on this computer and is not recorded.'
const DENIED = 'I cannot use the camera, because permission was not given.'
const NO_FACE = 'I cannot see a face, so I have stopped the camera check.'
const DONE = 'Thank you. The camera observation is complete.'

export type VisualStatus = 'idle' | 'starting' | 'running' | 'done' | 'denied' | 'error' | 'cancelled'

export type VisualRecord = {
  observation_id: string
  astronaut_id: string
  at: string
  observation: Observation
  notice: string
  affects_assessment: false
  /** Plain-language summary, built by the bridge from the numbers. */
  description?: string
  /** The crew member's callsign, when the bridge supplies it (latest-observation route). */
  callsign?: string | null
  /** What MeBo says afterwards: the observation, its quality, its limits (bridge-built). */
  explanation?: string
  /** Suggested next steps from the observational summary; the rules engine stays authoritative. */
  follow_up?: { kind: string; prompt: string }[]
}

type VisualState = {
  status: VisualStatus
  crewId: string
  /** Index into TASKS of the task in progress, or -1. */
  step: number
  progress: number
  status_line: string
  /** Per-task outcome so far. */
  done: Partial<Record<TaskId, boolean>>
  live: {
    face: boolean
    eyeOpen: number | null
    yaw: number | null
    /** Last sampled face-region brightness (0..255), for the lighting hint. */
    luma: number | null
    /** Outer-eye-corner distance in pixels, for the distance hint. */
    iodPx: number | null
  }
  /** What MeBo is saying or has just asked, shown large in the centre view. */
  instruction: string
  /** The camera experience is in the centre of the screen (Step 26C). */
  expanded: boolean
  startedAt: number
  endedAt: number
  error: string
  last: VisualRecord | Observation | null
  saved: boolean
}

const idle: Omit<VisualState, 'last' | 'saved'> = {
  status: 'idle',
  crewId: '',
  step: -1,
  progress: 0,
  status_line: '',
  done: {},
  live: { face: false, eyeOpen: null, yaw: null, luma: null, iodPx: null },
  instruction: '',
  expanded: false,
  startedAt: 0,
  endedAt: 0,
  error: '',
}

export const useVisual = create<VisualState>(() => ({ ...idle, last: null, saved: false }))

/** Return the camera experience to the side panel. The result stays there. */
export function collapseVisual() {
  // Never while a check or its questions are in progress: Stop ends them first.
  if (running || followUpActive()) return
  useVisual.setState({ expanded: false })
}

/**
 * The most recent stored camera check, across the crew, for the side panel
 * after a reload. Read-only; the bridge composes its description and
 * explanation from the stored numbers.
 */
export async function loadLatestVisual(): Promise<void> {
  // An interview interrupted by a reload can be resumed from the card.
  loadSavedFollowUp()
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/medical/visual-observations`)
    if (!res.ok) return
    const latest = (await res.json()).latest as VisualRecord | null
    // Never over a check in progress or a newer result from this session.
    const s = useVisual.getState()
    if (!latest || running || (s.last && 'at' in s.last && s.last.at >= latest.at)) return
    if (s.last && !('at' in s.last)) return
    useVisual.setState({ last: latest, saved: true })
    // And the sleep and fatigue assessment that followed it, if any.
    await restoreLinkedAssessment(latest.astronaut_id, latest.at)
  } catch {
    /* the bridge is optional for the panel */
  }
}

/** How MeBo speaks the instructions. The app registers its speech here. */
let speak: (text: string) => Promise<void> = async () => {}
export function configureVisual(opts: { say: (text: string) => Promise<void> }) {
  speak = opts.say
}

let running: AbortController | null = null
export const visualRunning = () => running !== null

/**
 * Stop a check in progress (panel button, Escape). The camera is released at
 * once, even while MeBo is still finishing a sentence; the check itself
 * winds down as soon as it notices.
 */
export function cancelVisualCheck() {
  if (!running) return
  running.abort()
  stopFace()
  const s = useVisual.getState()
  if (s.status === 'starting' || s.status === 'running') {
    useVisual.setState({ status: 'cancelled', step: -1, instruction: 'The camera check was stopped.', endedAt: Date.now() })
  }
}

/** File the summary with the bridge, which validates and stores it. */
async function record(crewId: string, observation: Observation): Promise<VisualRecord> {
  const res = await fetch(`${BRIDGE_HTTP_URL}/medical/visual-observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ crew_id: crewId, observation }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
  return body.recorded as VisualRecord
}

export type VisualResult =
  | { ok: true; recorded: VisualRecord | null; observation: Observation; saved: boolean; error?: string }
  | { ok: false; error: string }

/**
 * Run the guided check for one crew member. Never throws; every outcome,
 * including a refused camera, comes back as a result.
 *
 * @param opts.windowS natural-observation window (default: observationWindow())
 * @param opts.explain speak the explanation and first follow-up afterwards.
 *   True from the panel; false when MeBo asked for the check, because MeBo's
 *   own reply relays them and they must not be said twice.
 */
async function runCamera(
  crewId: string,
  opts: { windowS?: number; explain?: boolean; followUp?: boolean } = {},
): Promise<VisualResult> {
  if (running) return { ok: false, error: 'A camera check is already running.' }
  if (!crewId) return { ok: false, error: 'Which crew member is this for?' }
  const windowS = clampWindow(opts.windowS ?? observationWindow())
  const explain = opts.explain ?? true
  const ctrl = new AbortController()
  running = ctrl
  const set = useVisual.setState
  const intro = introFor(windowS)
  // Into the centre of the screen: the check is now the main thing happening.
  set({ ...idle, status: 'starting', crewId, expanded: true, startedAt: Date.now(), instruction: intro })

  const frames: Frame[] = []
  let liveAt = 0
  let luma: number | null = null
  const onFrame = (f: Frame) => {
    frames.push(f)
    if (f.luma !== null) luma = f.luma
    // The readout, a few times a second rather than at frame rate.
    if (f.t - liveAt > 200) {
      liveAt = f.t
      set({ live: { face: f.face, eyeOpen: f.eyeOpen, yaw: f.yaw, luma: f.face ? luma : null, iodPx: f.iodPx } })
    }
  }
  const finish = (s: Partial<VisualState>) => set({ ...s, step: -1, status_line: '', endedAt: Date.now() })

  const stopped = () => ctrl.signal.aborted
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  try {
    // Explain first, while the camera and model start. A refused permission
    // surfaces here, before any task is asked for.
    const camera = startFace(onFrame)
    camera.catch(() => {}) // handled below, after the explanation
    await speak(intro)
    try {
      await camera
    } catch (err) {
      const denied = (err as DOMException)?.name === 'NotAllowedError'
      const message = denied ? DENIED : `The camera check could not start: ${(err as Error)?.message ?? err}`
      finish({ status: denied ? 'denied' : 'error', error: message, instruction: message })
      void speak(denied ? DENIED : 'The camera check could not start.')
      return { ok: false, error: message }
    }
    if (stopped()) throw new Error('cancelled')
    set({ status: 'running' })

    const windows: TaskWindow[] = []
    for (let i = 0; i < TASKS.length; i++) {
      const task = TASKS[i]
      const said = instructionFor(task, windowS)
      set({ step: i, progress: 0, status_line: '', instruction: said })
      await speak(said)
      if (stopped()) throw new Error('cancelled')
      // Judged from when the instruction has been heard.
      const start = performance.now()
      let prompted = false
      for (;;) {
        await wait(100)
        if (stopped()) throw new Error('cancelled')
        const seen = frames.filter((f) => f.t >= start)
        const p = taskProgress(task.id, seen, windowS)
        set({ progress: p.progress, status_line: p.status })
        // Eyes shut means the panel cannot be read: say when it is time.
        if (task.id === 'eyes_closed' && !prompted && p.status === 'You can open your eyes') {
          prompted = true
          set({ instruction: 'You can open your eyes now.' })
          void speak('You can open your eyes now.')
        }
        if (taskOver(task.id, seen, (performance.now() - start) / 1000, windowS)) {
          const completed = taskProgress(task.id, seen, windowS).done
          windows.push({ id: task.id, start, end: performance.now(), completed })
          set((s) => ({ done: { ...s.done, [task.id]: completed } }))
          break
        }
      }
      // Nobody in front of the camera for the whole first task: stop rather
      // than ask an empty room to close its eyes.
      if (i === 0 && !frames.some((f) => f.t >= start && f.face)) {
        set({ instruction: NO_FACE })
        void speak(NO_FACE)
        break
      }
    }

    stopFace()
    const observation = summarize(frames, windows, windowS)
    // The frames go now: only the summary outlives the check.
    frames.length = 0
    set({ step: -1, status_line: 'Saving the observation' })
    let recorded: VisualRecord | null = null
    let saved = false
    let error: string | undefined
    try {
      recorded = await record(crewId, observation)
      saved = true
    } catch (err) {
      // Still shown on the panel; only the filing failed.
      error = `The observation could not be saved: ${(err as Error)?.message ?? err}`
    }
    finish({
      status: 'done',
      last: recorded ?? observation,
      saved,
      error: error ?? '',
      // Shown in the centre view: the same explanation MeBo speaks.
      instruction: recorded?.explanation ?? (windows.length === TASKS.length ? DONE : NO_FACE),
    })
    if (windows.length === TASKS.length) {
      // From the panel, MeBo explains what it observed, how good the
      // measurement was, its limits, and the first suggested next step —
      // all composed by the bridge from the numbers and the crew member's
      // records. When MeBo asked for the check, its reply says this instead.
      // With the sleep and fatigue follow-up coming, its own consent question
      // replaces the "would you like…" suggestion.
      const offer = !opts.followUp && recorded?.follow_up?.[0] ? ` ${recorded.follow_up[0].prompt}` : ''
      const said = explain && recorded?.explanation ? `${DONE} ${recorded.explanation}${offer}` : DONE
      // Awaited, so what follows never talks over it.
      await speak(said)
    }
    return { ok: true, recorded, observation, saved, ...(error ? { error } : {}) }
  } catch (err) {
    stopFace()
    const cancelled = stopped()
    const message = cancelled ? 'The camera check was stopped.' : String((err as Error)?.message ?? err)
    finish({ status: cancelled ? 'cancelled' : 'error', error: message, instruction: message })
    return { ok: false, error: message }
  } finally {
    stopFace()
    running = null
  }
}

/** How the camera did, in the follow-up's terms. */
function cameraQuality(r: VisualResult, status: VisualStatus): CameraOutcome {
  if (!r.ok) return { quality: status === 'denied' ? 'denied' : 'error', observationId: null }
  const o = r.observation
  return {
    quality: o.face_visible_ratio === 0 ? 'no_face' : (o.alertness?.quality.grade ?? 'none'),
    observationId: r.recorded?.observation_id ?? null,
  }
}

/**
 * The guided camera check, then (Step 26C) the sleep and fatigue workflow
 * that makes it useful: the missing structured questions, asked by MeBo, and
 * the rules engine's assessment (followup.ts). Not after Stop — the person
 * ended it. After a refused camera, no face or poor quality, MeBo says the
 * camera could not contribute and the questions go ahead.
 *
 * @param opts.followUp continue into the sleep and fatigue workflow (default true)
 */
export async function runVisualCheck(
  crewId: string,
  opts: { windowS?: number; explain?: boolean; followUp?: boolean } = {},
): Promise<VisualResult & { sleep_fatigue?: FollowOutcome }> {
  const followUp = opts.followUp ?? true
  // A new check starts a new follow-up.
  if (!running) useFollowUp.setState({ status: 'idle', result: null })
  const r = await runCamera(crewId, { ...opts, followUp })
  const status = useVisual.getState().status
  if (!followUp || status === 'cancelled' || (!r.ok && r.error === 'A camera check is already running.')) return r
  if (!crewId) return r
  // The centre view stays open through the questions.
  useVisual.setState({ expanded: true })
  const sleep_fatigue = await runFollowUp(crewId, cameraQuality(r, status))
  return { ...r, sleep_fatigue }
}

/**
 * The camera check alone, as the optional step of the guided health check
 * (Step 27): the questions and the assessment are the health check's, so no
 * follow-up starts here. Returns how the camera did.
 */
export async function runCameraStep(crewId: string): Promise<CameraOutcome> {
  const r = await runCamera(crewId, { followUp: true })
  return cameraQuality(r, useVisual.getState().status)
}

/** Resume an interrupted sleep and fatigue interview (after a reload or Stop). */
export async function resumeFollowUp(): Promise<FollowOutcome | null> {
  const saved = useFollowUp.getState().resumable ?? loadSavedFollowUp()
  if (!saved || running) return null
  useVisual.setState({ expanded: true, crewId: saved.crewId })
  return runFollowUp(saved.crewId, { quality: saved.cameraQuality, observationId: saved.observationId }, { resume: true })
}

export { OBSERVATION_NOTICE, TASKS }
