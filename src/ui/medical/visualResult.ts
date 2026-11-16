import type { VisualRecord } from '../../lib/visual/assessment'
import type { Observation } from '../../lib/visual/observe'

/**
 * A camera check's result, in words an astronaut can read at a glance — the
 * one source for both the centre view and the side card, so they can never
 * disagree. Display only: every number comes from the stored observation,
 * and nothing here grades the person.
 */

export type ResultTone = 'good' | 'limited' | 'insufficient'

export type ResultView = {
  /** COMPLETE · GOOD QUALITY, LIMITED QUALITY, … */
  status: string
  tone: ResultTone
  who: string | null
  at: string | null
  tiles: { label: string; value: string; note?: string }[]
  /** Why quality was limited or insufficient, in short plain phrases. */
  reasons: string[]
  explanation: string | null
  nextStep: string | null
}

/** Short, plain labels for the quality vocabulary in observe.ts. */
const REASON_LABEL: Record<string, string> = {
  no_observation: 'no natural observation',
  short_observation: 'too little time with eyes in view',
  below_window: 'part of the observation unusable',
  very_low_frame_rate: 'camera far too slow',
  low_frame_rate: 'camera running slowly',
  missing_frames: 'face out of view at times',
  head_turned: 'head often turned away',
  face_too_small: 'face too far from the camera',
  eye_asymmetry: 'eyes looked different (glare, glasses or covering)',
  no_closed_calibration: 'no eyes-closed calibration',
  closure_not_detected: 'eye closure not visible (glasses, glare or covering)',
  low_agreement: 'eye measures disagreed',
  too_dark: 'light too dim',
  too_bright: 'light too bright',
  illumination_changed: 'lighting changed',
}

/** Display tone for a rules-engine level (the level itself is the engine's, unchanged). */
export const toneOf = (level: string | null | undefined) =>
  level === 'urgent' || level === 'emergency' ? 'urgent' : level === 'review' ? 'limited' : 'good'

/** Display tone for a fatigue-concern level (Step 26D). Indeterminate is never shown as good. */
export const concernTone = (level: string | null | undefined) =>
  level === 'high' ? 'urgent' : level === 'moderate' || level === 'indeterminate' ? 'limited' : 'good'

export const reasonLabel = (r: string) => REASON_LABEL[r] ?? r.replace(/_/g, ' ')

const pct = (v: number) => `${Math.round(v * 100)}%`

export function resultView(last: VisualRecord | Observation | null, callsign: (id: string) => string): ResultView | null {
  if (!last) return null
  const rec = 'observation' in last ? last : null
  const o = rec ? rec.observation : (last as Observation)
  const a = o.alertness ?? null
  const done = o.tasks.filter((t) => t.completed).length
  const total = o.tasks.length

  let tone: ResultTone
  let status: string
  if (o.face_visible_ratio === 0) {
    tone = 'insufficient'
    status = 'NO FACE DETECTED'
  } else if (a) {
    tone = a.quality.grade
    status =
      a.quality.grade === 'good'
        ? 'COMPLETE · GOOD QUALITY'
        : a.quality.grade === 'limited'
          ? 'COMPLETE · LIMITED QUALITY'
          : 'COMPLETE · INSUFFICIENT FOR EYE MEASURES'
  } else {
    tone = done === total ? 'good' : 'limited'
    status = done === total ? 'COMPLETE' : 'PARTLY COMPLETE'
  }

  const usable = a && a.quality.grade !== 'insufficient' && a.perclos_p80 !== null
  const tiles: ResultView['tiles'] = [
    { label: 'Tasks completed', value: `${done} of ${total}` },
    { label: 'Face in view', value: pct(o.face_visible_ratio) },
  ]
  if (a) {
    tiles.push(
      {
        label: 'Eyes mostly closed',
        value: usable ? `${pct(a.perclos_p80 as number)} of the time` : 'not measured',
        note: 'PERCLOS: time with eyes at least 80% closed',
      },
      {
        label: 'Blinks',
        // Under 2 a minute is a missed-blink measurement, not a person.
        value: usable && (a.blink_rate_per_min ?? 0) >= 2 ? `about ${Math.round(a.blink_rate_per_min as number)} a minute` : 'not counted',
        note: 'not yet validated',
      },
      { label: 'Longest eye closure', value: usable ? `${a.longest_closure_s.toFixed(1)} s` : 'not measured' },
      { label: 'Measurement quality', value: a.quality.grade[0].toUpperCase() + a.quality.grade.slice(1) },
    )
  } else {
    tiles.push({ label: 'Blinks (whole check)', value: String(o.indicators.blinks) })
  }

  return {
    status,
    tone,
    who: rec ? (rec.callsign ?? callsign(rec.astronaut_id)) : null,
    at: rec?.at ?? null,
    tiles,
    reasons: (a?.quality.reasons ?? []).map(reasonLabel),
    // No face at all: say that, and what helps, rather than a note about
    // measures that never had a chance to run.
    explanation:
      o.face_visible_ratio === 0
        ? 'I could not see a face, so the check stopped. Please sit in front of the camera with your whole face in view, in good light, and try again.'
        : (rec?.explanation ?? null),
    nextStep: rec?.follow_up?.[0]?.prompt ?? null,
  }
}

/** "just now", "12 min ago", "3 h ago", or a date. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return ''
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
