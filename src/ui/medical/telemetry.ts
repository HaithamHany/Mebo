import { create } from 'zustand'
import { BRIDGE_HTTP_URL } from '../../config'

/**
 * Crew health data for the MeBo console, from the medical data service.
 *
 * The values come from MeBo's local SQLite database (medical/), served
 * read-only by the bridge at /medical. That service is LLM-independent: this
 * module talks to it over plain HTTP, never through the assistant.
 *
 * THE DATA IS SYNTHETIC. Four fictional astronauts on a fictional Mars
 * transit, generated deterministically from a documented scenario
 * (docs/medical-data.md). Every response carries a notice saying so, and the
 * cards say SIMULATED on their faces.
 *
 * Kept out of the main store on purpose: the voice loop, the bridge and the
 * blades live there, and none of them should re-render because the medical
 * data refreshed.
 */

export type MetricCode =
  | 'heart_rate'
  | 'bp_systolic'
  | 'bp_diastolic'
  | 'spo2'
  | 'respiratory_rate'
  | 'body_temperature'
  | 'sleep_duration'
  | 'mood'
  | 'activity'
  | 'radiation_dose'

export type Latest = {
  value: number
  unit: string
  observed_at: string
  mission_day: number
  source_id: string
  is_simulated: boolean
  age_hours: number
  /** Older than the service's freshness window: not a current reading. */
  stale: boolean
}

export type MetricSummary = {
  metric: MetricCode
  name: string
  unit: string
  latest: Latest | null
  baseline: { method: string; mean: number; sd: number; n: number } | null
  /** Statistical distance from this person's own baseline. Not clinical. */
  deviation: { delta: number; z: number | null; baseline_method: string } | null
  cumulative?: { value: number; unit: string; days: number }
}

export type CrewSummary = {
  id: string
  callsign: string
  role: string
  display_name: string
  is_synthetic: boolean
  profile_notes: string
  metrics: Record<MetricCode, MetricSummary>
  trend: {
    metric: MetricCode
    unit: string
    daily: { day: number; mean: number; n: number }[]
    coverage: number | null
    missing_days: number[]
    slope_per_week: number | null
  }
}

export type Mission = {
  id: string
  name: string
  destination: string
  launch_at: string
  scenario_now: string
  inflight_days: number
  crew_count: number
  is_simulated: boolean
}

export type Cabin = {
  /** Total pressure, kPa. */
  pressure: number
  /** Partial pressure of O2, kPa. */
  ppo2: number
  /** Partial pressure of CO2, mmHg. */
  ppco2: number
  /** Cabin air temperature, °C. */
  temp: number
  /** Relative humidity, %. */
  humidity: number
}

/**
 * How many standard deviations from a person's own pre-flight baseline before
 * the console draws a value in amber. A statistical cue, not a clinical
 * threshold: in-flight adaptation is expected to move values away from the
 * ground baseline, and amber says only that this value is unusual *for this
 * person*.
 */
export const DEVIATION_Z = 2

export const DATA_URL = `${BRIDGE_HTTP_URL}/medical/dashboard?days=30&metric=heart_rate`

// The cabin environment is outside the medical database's scope for now, so
// it keeps its client-side simulation (and the card keeps its SIMULATED tag).
const CABIN_BASE: Cabin = { pressure: 101.3, ppo2: 21.3, ppco2: 2.4, temp: 22.4, humidity: 46 }
const CABIN_STEP: Cabin = { pressure: 0.06, ppo2: 0.05, ppco2: 0.08, temp: 0.05, humidity: 0.4 }

function walk(cur: Cabin): Cabin {
  const out = { ...cur }
  for (const k of Object.keys(CABIN_BASE) as (keyof Cabin)[]) {
    out[k] = cur[k] + (Math.random() * 2 - 1) * CABIN_STEP[k] + (CABIN_BASE[k] - cur[k]) * 0.18
  }
  return out
}

export type WorkflowId = 'cardiovascular' | 'sleep_fatigue'

/** One medical tool call, as the bridge reports it (Step 23). */
export type MedicalActivity = {
  tool: string
  crew_id: string | null
  phase: 'start' | 'end'
  at: string
  ok?: boolean
  workflow?: WorkflowId
  level?: string
  status?: string
  summary?: string
  assessment_id?: string
  callsign?: string | null
  error?: string
}

/** The latest outcome of a workflow, for the Medical Agents panel. */
export type WorkflowStatus = {
  callsign: string
  level: string
  status: string
  summary: string
  at: string
  assessment_id: string
}

/** A check that has begun and is waiting on its questions; it goes stale after this. */
const CHECK_TIMEOUT_MS = 15 * 60_000

export const MEMORY_URL = `${BRIDGE_HTTP_URL}/medical/memory`

type MedState = {
  status: 'loading' | 'ready' | 'offline'
  error: string
  notice: string
  mission: Mission | null
  crew: CrewSummary[]
  selected: string
  cabin: Cabin
  /** Mission elapsed time, seconds: the scenario's time, then counting on. */
  met: number
  /** The medical tool running right now, if any. */
  activity: MedicalActivity | null
  /** Checks begun but not yet assessed (MeBo is asking the questions). */
  checking: Partial<Record<WorkflowId, { callsign: string; since: number }>>
  /** The most recent assessment of each workflow, from memory and live activity. */
  lastAssessment: Partial<Record<WorkflowId, WorkflowStatus>>
  select: (id: string) => void
  tick: () => void
  load: () => Promise<void>
  noteActivity: (a: MedicalActivity) => void
}

export const useMedical = create<MedState>((set, get) => ({
  status: 'loading',
  error: '',
  notice: '',
  mission: null,
  crew: [],
  selected: '',
  cabin: { ...CABIN_BASE },
  met: 0,
  activity: null,
  checking: {},
  lastAssessment: {},

  noteActivity: (a) =>
    set((s) => {
      if (a.phase === 'start') return { activity: a }
      const checking = { ...s.checking }
      const lastAssessment = { ...s.lastAssessment }
      const who = a.callsign ?? s.crew.find((c) => c.id === a.crew_id)?.callsign ?? a.crew_id ?? '—'
      if (a.ok && a.workflow && a.assessment_id) {
        lastAssessment[a.workflow] = {
          callsign: who, level: a.level ?? 'none', status: a.status ?? 'complete',
          summary: a.summary ?? '', at: a.at, assessment_id: a.assessment_id,
        }
        delete checking[a.workflow]
      } else if (a.ok && a.workflow && a.tool === 'begin_medical_check') {
        checking[a.workflow] = { callsign: who, since: Date.parse(a.at) || Date.now() }
      }
      return { activity: null, checking, lastAssessment }
    }),

  select: (selected) => set({ selected }),
  tick: () => set((s) => ({ cabin: walk(s.cabin), met: s.met ? s.met + 1 : 0 })),

  load: async () => {
    try {
      const res = await fetch(DATA_URL)
      const body = await res.json()
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const mission = body.mission as Mission
      const crew = body.crew as CrewSummary[]
      const prev = get()
      set({
        status: 'ready',
        error: '',
        notice: body.notice,
        mission,
        crew,
        // Keep the user's choice across refreshes; default to the first.
        selected: crew.some((c) => c.id === prev.selected) ? prev.selected : (crew[0]?.id ?? ''),
        // Only set the clock on the first load, so a refresh does not jump it.
        met: prev.met || Math.max(0, (Date.parse(mission.scenario_now) - Date.parse(mission.launch_at)) / 1000),
      })
    } catch (err) {
      set({ status: 'offline', error: String((err as Error)?.message ?? err) })
      return
    }
    // The panel's last outcomes, from memory, so they survive a reload. A
    // bridge older than Step 23 has no memory route; the panel then waits for
    // live activity instead.
    try {
      const res = await fetch(MEMORY_URL)
      if (!res.ok) return
      const latest = ((await res.json()).latest ?? {}) as Record<string, WorkflowStatus & { astronaut_id: string; workflow: WorkflowId }>
      const crew = get().crew
      const fromMemory: MedState['lastAssessment'] = {}
      for (const [wf, a] of Object.entries(latest)) {
        fromMemory[wf as WorkflowId] = {
          callsign: crew.find((c) => c.id === a.astronaut_id)?.callsign ?? a.astronaut_id,
          level: a.level, status: a.status, summary: a.summary, at: a.at, assessment_id: a.assessment_id,
        }
      }
      // Live activity is newer than anything a refresh reads back.
      set((s) => ({ lastAssessment: { ...fromMemory, ...s.lastAssessment } }))
    } catch {
      /* memory is optional for the panel */
    }
  },
}))

/** The panel's view of one workflow right now. */
export function workflowView(
  s: Pick<MedState, 'activity' | 'checking' | 'lastAssessment' | 'crew'>,
  wf: WorkflowId,
  nowMs = Date.now(),
): { state: 'running' | 'checking' | 'done' | 'idle'; text: string; alert: boolean } {
  const tool = s.activity?.tool ?? ''
  if (s.activity && (tool === `assess_${wf}` || (tool === 'begin_medical_check' && s.activity.workflow === wf))) {
    const who = s.crew.find((c) => c.id === s.activity!.crew_id)?.callsign ?? ''
    return { state: 'running', text: `Assessing${who ? ` ${who}` : ''}…`, alert: false }
  }
  const check = s.checking[wf]
  if (check && nowMs - check.since < CHECK_TIMEOUT_MS) {
    return { state: 'checking', text: `${check.callsign} · asking questions`, alert: false }
  }
  const last = s.lastAssessment[wf]
  if (last) {
    const mins = Math.max(0, Math.round((nowMs - Date.parse(last.at)) / 60000))
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`
    const level = last.status === 'incomplete' && last.level === 'none' ? 'INCOMPLETE' : last.level.toUpperCase()
    return { state: 'done', text: `${last.callsign} · ${level} · ${ago}`, alert: ['review', 'urgent', 'emergency'].includes(last.level) }
  }
  return { state: 'idle', text: '', alert: false }
}

/** The current value of a metric, or null if there is none or it is stale. */
export function current(c: CrewSummary | undefined, code: MetricCode): number | null {
  const l = c?.metrics[code]?.latest
  return l && !l.stale ? l.value : null
}

/** Is this value unusually far from the person's own baseline? */
export function deviates(c: CrewSummary | undefined, code: MetricCode): boolean {
  const z = c?.metrics[code]?.deviation?.z
  return z !== null && z !== undefined && Math.abs(z) >= DEVIATION_Z
}

export function selectedCrew(s: Pick<MedState, 'crew' | 'selected'>): CrewSummary | undefined {
  return s.crew.find((c) => c.id === s.selected)
}

/** Heart rate driving the ECG and the anatomy heart, or null for no signal. */
export function liveHeartRate(): number | null {
  return current(selectedCrew(useMedical.getState()), 'heart_rate')
}

/** A value for display, or an em dash when there is none. */
export function fmt(v: number | null | undefined, digits = 0): string {
  return v === null || v === undefined ? '—' : v.toFixed(digits)
}

/** `DDD:HH:MM:SS`, the way mission clocks are read. */
export function formatMet(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${String(d).padStart(3, '0')}:${p(h)}:${p(m)}:${p(s)}`
}
