import { create } from 'zustand'
import { useMedical } from '../ui/medical/telemetry'
import { cancelFollowUp, followUpActive, runFollowUp, useFollowUp } from './visual/followup'
import { cancelVisualCheck, collapseVisual, runCameraStep, visualRunning } from './visual/assessment'

/**
 * The guided health check (Step 27): one workflow from choosing a crew member
 * to the results, built only from what already exists.
 *
 *   Crew → Health Review → Questions → Camera (optional) → Results
 *
 *   Crew          the four simulated astronauts from the medical database
 *   Health Review their own records: sleep against their baseline, trends
 *   Questions     the sleep and fatigue questions, by voice or on screen
 *                 (followup.ts, in guided mode: starting the check was consent)
 *   Camera        the guided camera check, offered and skippable; it runs
 *                 before the assessment so the fatigue concern can use it
 *   Results       the rules engine's assessment and the Step 26D fatigue
 *                 concern, spoken by MeBo and shown here
 *
 * No thresholds, findings or wording are made here: every level, finding and
 * piece of guidance comes from the rules engine or the fatigue concern, and
 * what MeBo says is what the screen shows.
 */

export type Stage = 'off' | 'crew' | 'review' | 'questions' | 'camera' | 'results'
export const STAGES: { id: Exclude<Stage, 'off'>; label: string; optional?: boolean }[] = [
  { id: 'crew', label: 'Crew' },
  { id: 'review', label: 'Health Review' },
  { id: 'questions', label: 'Questions' },
  { id: 'camera', label: 'Camera', optional: true },
  { id: 'results', label: 'Results' },
]

type State = {
  stage: Stage
  /** The crew member being assessed. Fixed once the review starts. */
  crewId: string
  /** What MeBo is saying at this stage, shown on screen as well. */
  say: string
  /** The camera step: waiting for a choice, running, or skipped/finished. */
  camera: 'offer' | 'running' | 'done' | 'skipped'
}

export const useHealthCheck = create<State>(() => ({ stage: 'off', crewId: '', say: '', camera: 'offer' }))
export const healthCheckActive = () => useHealthCheck.getState().stage !== 'off'

let speak: (text: string) => Promise<void> = async () => {}
export function configureHealthCheck(opts: { say: (text: string) => Promise<void> }) {
  speak = opts.say
}

const callsign = (id: string) => useMedical.getState().crew.find((c) => c.id === id)?.callsign ?? id.toUpperCase()

/**
 * "Start Health Check" on the opening screen: open the check as soon as the
 * console is up and the crew has loaded (HealthCheck watches for this).
 */
let requested = false
export const requestHealthCheck = () => (requested = true)
export function takeHealthCheckRequest() {
  const r = requested
  requested = false
  return r
}

/** Open the check at the crew choice. The current selection is preselected. */
export function openHealthCheck() {
  if (healthCheckActive()) return
  useHealthCheck.setState({ stage: 'crew', crewId: useMedical.getState().selected, say: '', camera: 'offer' })
}

/** Highlight a crew member. Only Continue starts anything. */
export function chooseCrew(id: string) {
  if (useHealthCheck.getState().stage !== 'crew') return
  useHealthCheck.setState({ crewId: id })
}

/** Continue as the chosen crew member: their health review, and MeBo's welcome. */
export async function beginReview() {
  const { crewId } = useHealthCheck.getState()
  if (!crewId) return
  useMedical.getState().select(crewId)
  const c = useMedical.getState().crew.find((x) => x.id === crewId)
  const sleep = c?.metrics.sleep_duration
  const record =
    sleep?.latest && sleep.baseline
      ? ` Your last recorded sleep was ${sleep.latest.value.toFixed(1)} hours; before the mission it averaged ${sleep.baseline.mean.toFixed(1)} hours.`
      : ''
  const say =
    `Hello ${callsign(crewId)}. I will start with your recent records, then ask a few short questions about sleep and fatigue. ` +
    `A camera check is optional. Then I will give you your results.${record} When you are ready, choose Start questions.`
  useHealthCheck.setState({ stage: 'review', say })
  await speak(say)
}

let cameraChoice: ((c: 'start' | 'skip') => void) | null = null

/** The questions, the optional camera, then the assessment — one guided run. */
export async function startQuestions() {
  const { crewId } = useHealthCheck.getState()
  if (!crewId || followUpActive()) return
  useHealthCheck.setState({ stage: 'questions', say: '', camera: 'offer' })
  // A new check: the previous result gives way to this one.
  useFollowUp.setState({ status: 'idle', result: null, concern: null })
  await runFollowUp(
    crewId,
    { quality: 'skipped', observationId: null },
    {
      guided: {
        beforeAssess: async () => {
          const say =
            'Thank you. Optionally, I can add a short camera observation of your eyes, about two minutes. ' +
            'It is processed on this computer and not recorded. Choose Start camera check, or Skip.'
          useHealthCheck.setState({ stage: 'camera', say, camera: 'offer' })
          const choice = new Promise<'start' | 'skip'>((resolve) => (cameraChoice = resolve))
          void speak(say)
          const c = await choice
          cameraChoice = null
          if (c === 'start' && healthCheckActive()) {
            useHealthCheck.setState({ camera: 'running' })
            const cam = await runCameraStep(crewId)
            collapseVisual()
            useHealthCheck.setState({ camera: 'done' })
            return cam
          }
          useHealthCheck.setState({ camera: 'skipped' })
          return null
        },
      },
    },
  )
  if (healthCheckActive()) useHealthCheck.setState({ stage: 'results', say: '' })
}

export function chooseCamera(c: 'start' | 'skip') {
  cameraChoice?.(c)
}

/**
 * Leave the check: anything in progress stops (answers so far are kept for
 * 30 minutes and can be resumed from the camera card); a filed assessment
 * stays filed and shown in the side card.
 */
export function closeHealthCheck() {
  if (visualRunning()) cancelVisualCheck()
  if (followUpActive()) cancelFollowUp()
  cameraChoice?.('skip')
  useHealthCheck.setState({ stage: 'off', say: '' })
}
