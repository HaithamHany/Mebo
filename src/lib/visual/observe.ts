/**
 * Camera observations: what a face-landmark tracker can honestly report.
 *
 * Pure functions, no browser or app imports, so the rules are testable as they
 * are (test/visual-observation.test.mjs, test/alertness.test.mjs). The browser
 * side (face.ts) feeds frames in; the bridge validates and stores only the
 * summary this produces.
 *
 * What it measures — observable facts about the camera picture:
 *   - whether a face is in view, and how large and frontal it is;
 *   - eye opening, two independent ways: the eye aspect ratio (EAR) of the
 *     landmarks (Soukupová & Čech 2016), and MediaPipe's eyeBlink blendshapes;
 *   - over a natural-observation window: PERCLOS (the share of time the eyes
 *     are at least 80% closed), blinks and eye-closure durations;
 *   - head orientation, approximately, and head movement;
 *   - whether each instructed task was completed;
 *   - how trustworthy all of that is: valid-frame share, frame rate, gaps,
 *     lighting, left/right consistency and the agreement of the two methods.
 *
 * What it does not do: diagnose, or decide anything. PERCLOS and blink
 * measures are research measures associated with drowsiness in laboratory
 * and driving studies; they are not validated for this camera, this software,
 * this population or spaceflight, and no cut-off here is a clinical one. A
 * long eye closure is a fact about the video, not about the person. The
 * summary carries no level, score, verdict or fitness-for-duty judgement.
 * docs/alertness-assessment.md documents every equation, window, threshold
 * and source, and separates published research from prototype choices.
 */

export const OBSERVATION_NOTICE =
  'Camera observation only: what the video showed (face in view, eye opening, PERCLOS, blinks, head ' +
  'movement, tasks completed). Not a diagnosis, not a measure of fitness for duty, and not evidence of ' +
  'fatigue, illness or mood on its own. Supplementary to the rule-based assessments; it never changes an ' +
  'assessment or an escalation level.'

/**
 * Prototype assumptions for the guided tasks (camera observation quality,
 * not clinical):
 *   CLOSED_BELOW   blendshape eye openness under this counts as closed
 *   BLINK_MAX_S    a closure this short or shorter is a blink
 *   PROLONGED_S    an unprompted closure this long is reported as prolonged
 *   FACING_DEG     head yaw within this counts as facing the camera
 *   TURN_DEG       head yaw beyond this, either way, counts as a turn
 *   STEADY_MAX     head movement (eye-widths per second) under this counts as
 *                  holding still, for the hold-still task's own completion note
 *   MIN_VISIBLE    share of a timed task's frames that must show a face
 */
export const LIMITS = {
  CLOSED_BELOW: 0.35,
  BLINK_MAX_S: 0.5,
  PROLONGED_S: 2,
  FACING_DEG: 15,
  TURN_DEG: 20,
  STEADY_MAX: 0.25,
  MIN_VISIBLE: 0.7,
} as const

/**
 * The natural-observation (alertness) measures. P80 is the published PERCLOS
 * definition (eyes at least 80% closed: FHWA 1998, after Wierwille et al.
 * 1994). Everything else is a prototype choice, documented in
 * docs/alertness-assessment.md, and none is a validated cut-off.
 */
export const ALERTNESS = {
  /** Observation window, seconds. Published PERCLOS is defined per minute. */
  WINDOW_S: 60,
  MIN_WINDOW_S: 20,
  MAX_WINDOW_S: 180,
  /** Less valid eye-tracking time than this and no rate is reported. */
  MIN_VALID_S: 20,
  /** PERCLOS P80: openness at or below 0.2, i.e. at least 80% closed. */
  P80_OPENNESS: 0.2,
  /** A closure episode is openness below half way. */
  CLOSURE_OPENNESS: 0.5,
  /** A frame more than this after the previous one is a gap, not continuity. */
  MAX_FRAME_GAP_S: 0.25,
  /** Eye measures are taken only with the head within this yaw. */
  MAX_YAW_DEG: 30,
  /**
   * ...and with the outer eye corners at least this far apart in the picture.
   * Below it an open eye spans only a few pixels. In the browser validation,
   * MediaPipe did not detect faces at 55–83 px at all, and tracked them well
   * at 211 px and above.
   */
  MIN_IOD_PX: 80,
  /**
   * Blendshape (eyeBlink) references when a session gives no calibration.
   * Measured in the browser validation on real photographs: open eyes
   * 0.08–0.15, closed eyes 0.71–0.75. Prototype defaults, not general values.
   */
  BLINK_OPEN_REF: 0.12,
  BLINK_CLOSED_REF: 0.73,
  /** Open and closed EAR must differ by this much for a usable calibration. */
  MIN_EAR_RANGE: 0.05,
  /** One eye open and the other shut (by this much openness) is not trusted. */
  MAX_EYE_DIFFERENCE: 0.6,
  /** Frame rates: below GOOD_FPS short blinks can be missed; below MIN_FPS nothing is reported. */
  GOOD_FPS: 20,
  MIN_FPS: 8,
  /** Share of the window with valid eye tracking for "good". */
  GOOD_VALID_RATIO: 0.8,
  /** EAR and blendshape eye state should agree this often. */
  MIN_AGREEMENT: 0.8,
  /** Face-region brightness (0..255). */
  LUMA_DARK: 40,
  LUMA_BRIGHT: 220,
  LUMA_RANGE: 60,
  /** A share of frames excluded for one reason above this is reported. */
  REASON_SHARE: 0.1,
} as const

export type Point = { x: number; y: number; z?: number }

/** One analysed video frame. Numbers only — no image is ever kept. */
export type Frame = {
  /** Milliseconds, any monotonic clock. */
  t: number
  face: boolean
  /** Blendshape eye openness: 0 shut .. 1 open, or null when unknown. */
  eyeOpen: number | null
  /** Degrees. Positive yaw: turned toward the person's own left. Approximate. */
  yaw: number | null
  pitch: number | null
  roll: number | null
  /** Nose tip, in aspect-corrected normalised units, for movement. */
  nose: { x: number; y: number } | null
  /** Distance between the outer eye corners, same units: the face's scale. */
  scale: number | null
  /** Eye aspect ratio of the person's right eye (image left), from six landmarks. */
  earR: number | null
  /** ...and of their left eye. */
  earL: number | null
  /** Mean of the eyeBlinkLeft/Right blendshapes, raw (0 open .. 1 shut), or null. */
  blink: number | null
  /** Outer-eye-corner distance in video pixels: how large the face is in the picture. */
  iodPx: number | null
  /** Mean brightness of the face region (0..255) when sampled on this frame, else null. */
  luma: number | null
}

// MediaPipe Face Mesh landmark indices (canonical 468-point topology; the
// Face Landmarker adds 10 iris points, 468-477).
const NOSE = 1
const FOREHEAD = 10
const CHIN = 152
const CHEEK_A = 234 // image left in an unmirrored frame (the person's right)
const CHEEK_B = 454
const EYE_A_OUTER = 33
const EYE_B_OUTER = 263

/**
 * The six landmarks per eye used for EAR, in Soukupová & Čech's order
 * p1..p6: p1 and p4 the eye corners, p2/p6 and p3/p5 vertical lid pairs.
 * These are the indices commonly used with MediaPipe's mesh; MediaPipe does
 * not itself define an EAR.
 */
export const EAR_POINTS = {
  /** The person's right eye (image left): outer 33, inner 133. */
  right: [33, 160, 158, 133, 153, 144],
  /** The person's left eye: inner 362, outer 263. */
  left: [362, 385, 387, 263, 373, 380],
} as const

const DEG = 180 / Math.PI
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
type XY = { x: number; y: number }
const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * Eye aspect ratio (Soukupová & Čech 2016):
 *   EAR = (‖p2 − p6‖ + ‖p3 − p5‖) / (2 ‖p1 − p4‖)
 * Roughly constant while the eye is open, falling toward 0 as it closes.
 * Points must be in a common scale (x corrected for the frame's aspect).
 */
export function eyeAspectRatio(p: XY[]): number | null {
  const [p1, p2, p3, p4, p5, p6] = p
  const w = dist(p1, p4)
  if (!(w > 0)) return null
  return (dist(p2, p6) + dist(p3, p5)) / (2 * w)
}

/**
 * One frame from the tracker's output.
 *
 * @param landmarks the first face's landmarks (normalised 0..1), or null/empty
 *   when no face was found
 * @param blend MediaPipe blendshape scores by name, if requested
 * @param aspect video width / height, so x and y share a scale
 * @param extra video height in pixels (for face size) and a brightness sample
 */
export function frameFrom(
  landmarks: Point[] | null | undefined,
  blend: Record<string, number> | null | undefined,
  t: number,
  aspect = 16 / 9,
  extra: { height?: number; luma?: number | null } = {},
): Frame {
  const luma = extra.luma ?? null
  if (!landmarks || landmarks.length < 468) {
    return {
      t, face: false, eyeOpen: null, yaw: null, pitch: null, roll: null, nose: null, scale: null,
      earR: null, earL: null, blink: null, iodPx: null, luma,
    }
  }
  const p = (i: number) => ({ x: landmarks[i].x * aspect, y: landmarks[i].y })

  const nose = p(NOSE)
  const a = p(CHEEK_A)
  const b = p(CHEEK_B)
  const half = Math.abs(b.x - a.x) / 2
  // Nose offset from the middle of the face, as a share of its half-width.
  // The person's left is the image's right in an unmirrored frame, so a nose
  // moving right is a turn toward their left: positive.
  const yaw = half > 0 ? Math.asin(clamp((nose.x - (a.x + b.x) / 2) / half, -1, 1)) * DEG : null

  const top = p(FOREHEAD)
  const bottom = p(CHIN)
  const halfH = Math.abs(bottom.y - top.y) / 2
  // Uncalibrated (the nose does not sit at the exact middle at rest), so only
  // its range over a session is reported, never its absolute value.
  const pitch = halfH > 0 ? Math.asin(clamp(((top.y + bottom.y) / 2 - nose.y) / halfH, -1, 1)) * DEG : null

  const ea = p(EYE_A_OUTER)
  const eb = p(EYE_B_OUTER)
  const roll = Math.atan2(eb.y - ea.y, eb.x - ea.x) * DEG
  const scale = dist(ea, eb)

  const earR = eyeAspectRatio(EAR_POINTS.right.map(p))
  const earL = eyeAspectRatio(EAR_POINTS.left.map(p))

  const l = blend?.eyeBlinkLeft
  const r = blend?.eyeBlinkRight
  const blink = typeof l === 'number' && typeof r === 'number' ? clamp((l + r) / 2, 0, 1) : null
  // The guided tasks' eye state: blendshapes when available, else a fixed
  // mapping of EAR (about 0.3 open, under 0.1 shut).
  const eyeOpen =
    blink !== null
      ? 1 - blink
      : earR !== null && earL !== null
        ? clamp(((earR + earL) / 2 - 0.1) / 0.2, 0, 1)
        : null

  return {
    t, face: true, eyeOpen, yaw, pitch, roll, nose, scale, earR, earL, blink,
    iodPx: extra.height ? scale * extra.height : null,
    luma,
  }
}

// ---------------------------------------------------------------------------
// The guided tasks
// ---------------------------------------------------------------------------

export type TaskId = 'face_camera' | 'natural_gaze' | 'eyes_closed' | 'head_turn' | 'hold_still'

export type TaskDef = {
  id: TaskId
  label: string
  /** What MeBo says, exactly. Instructions, never interpretations. `{window}` is the spoken window length. */
  instruction: string
  /** Give up after this long; the task is then reported as not completed. */
  timeoutS: number
}

export const PROTOCOL = 'face_alertness_v2'

/**
 * In this order on purpose: the natural observation comes before the
 * instructed eye closure and head turns, so nothing asked of the person has
 * just happened when their ordinary blinking is measured.
 */
export const TASKS: readonly TaskDef[] = [
  { id: 'face_camera', label: 'Face camera', instruction: 'Please look straight at the camera.', timeoutS: 12 },
  {
    id: 'natural_gaze',
    label: 'Natural gaze',
    instruction: 'Now please look at the camera naturally for {window}, and blink as you normally would.',
    timeoutS: 0, // the window plus a margin; see taskTimeout
  },
  { id: 'eyes_closed', label: 'Eye closure', instruction: 'Please close your eyes for three seconds, then open them.', timeoutS: 15 },
  { id: 'head_turn', label: 'Head turn', instruction: 'Please turn your head slowly to one side, then to the other side.', timeoutS: 15 },
  { id: 'hold_still', label: 'Hold still', instruction: 'Please look at the camera and hold still for five seconds.', timeoutS: 9 },
]

/** A window length as MeBo says it: "thirty seconds", "one minute", "ninety seconds". */
export function spokenDuration(seconds: number): string {
  const words: Record<number, string> = {
    20: 'twenty seconds', 30: 'thirty seconds', 40: 'forty seconds', 45: 'forty-five seconds',
    60: 'one minute', 90: 'ninety seconds', 120: 'two minutes', 150: 'two and a half minutes', 180: 'three minutes',
  }
  return words[seconds] ?? `${seconds} seconds`
}

export const clampWindow = (s: number) =>
  Number.isFinite(s) ? clamp(Math.round(s), ALERTNESS.MIN_WINDOW_S, ALERTNESS.MAX_WINDOW_S) : ALERTNESS.WINDOW_S

export function instructionFor(task: TaskDef, windowS: number = ALERTNESS.WINDOW_S): string {
  return task.instruction.replace('{window}', spokenDuration(clampWindow(windowS)))
}

export function taskTimeout(id: TaskId, windowS: number = ALERTNESS.WINDOW_S): number {
  if (id === 'natural_gaze') return clampWindow(windowS) + 10
  return TASKS.find((t) => t.id === id)?.timeoutS ?? 10
}

/** How long hold_still observes once begun. */
const HOLD_S = 5
/** How long the face must stay facing the camera for face_camera. */
const FACING_S = 1.5

export type TaskProgress = {
  done: boolean
  /** 0..1, for the panel's progress display. */
  progress: number
  /** A short, factual status line for the panel. */
  status: string
}

/** Longest run, in seconds, of consecutive frames satisfying `ok`, and the run still going. */
function longestRun(frames: Frame[], ok: (f: Frame) => boolean): { longest: number; current: number } {
  let longest = 0
  let start: number | null = null
  let current = 0
  for (const f of frames) {
    if (ok(f)) {
      start ??= f.t
      current = (f.t - start) / 1000
      longest = Math.max(longest, current)
    } else {
      start = null
      current = 0
    }
  }
  return { longest, current }
}

const closed = (f: Frame) => f.face && f.eyeOpen !== null && f.eyeOpen < LIMITS.CLOSED_BELOW
const spanS = (frames: Frame[]) => (frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / 1000 : 0)

/**
 * Has the task been done, judged from the frames since it began?
 * Completion means the instruction was carried out on camera — nothing more.
 */
export function taskProgress(id: TaskId, frames: Frame[], windowS: number = ALERTNESS.WINDOW_S): TaskProgress {
  const visible = frames.length ? frames.filter((f) => f.face).length / frames.length : 0
  const last = frames[frames.length - 1]
  if (id === 'face_camera') {
    const run = longestRun(frames, (f) => f.face && f.yaw !== null && Math.abs(f.yaw) <= LIMITS.FACING_DEG)
    const done = run.longest >= FACING_S
    return {
      done,
      progress: clamp(run.current / FACING_S, 0, 1),
      status: done ? 'Facing the camera' : !last?.face ? 'No face in view' : 'Turn toward the camera',
    }
  }
  if (id === 'natural_gaze') {
    const win = clampWindow(windowS)
    const span = spanS(frames)
    const done = span >= win && visible >= LIMITS.MIN_VISIBLE
    return {
      done,
      progress: clamp(span / win, 0, 1),
      status: span >= win ? (done ? 'Observed' : 'Face not in view enough') : !last?.face ? 'No face in view' : 'Observing',
    }
  }
  if (id === 'eyes_closed') {
    // Closed for the whole hold, then seen open again.
    let held = 0
    let start: number | null = null
    let reopened = false
    for (const f of frames) {
      if (closed(f)) {
        start ??= f.t
        held = Math.max(held, (f.t - start) / 1000)
      } else {
        if (start !== null && held >= LIMITS.PROLONGED_S && f.face && f.eyeOpen !== null) reopened = true
        start = null
      }
    }
    const now = start !== null && last ? (last.t - start) / 1000 : 0
    const done = reopened
    return {
      done,
      progress: done ? 1 : clamp(Math.max(now, held >= LIMITS.PROLONGED_S ? LIMITS.PROLONGED_S : 0) / LIMITS.PROLONGED_S, 0, 1),
      status: done ? 'Eyes closed and opened' : held >= LIMITS.PROLONGED_S ? 'You can open your eyes' : now > 0 ? 'Eyes closed' : !last?.face ? 'No face in view' : 'Eyes open',
    }
  }
  if (id === 'head_turn') {
    const yaws = frames.filter((f) => f.face && f.yaw !== null).map((f) => f.yaw as number)
    const one = yaws.some((y) => y >= LIMITS.TURN_DEG)
    const other = yaws.some((y) => y <= -LIMITS.TURN_DEG)
    const done = one && other
    return {
      done,
      progress: (Number(one) + Number(other)) / 2,
      status: done ? 'Turned both ways' : one || other ? 'Now the other side' : !last?.face ? 'No face in view' : 'Turn your head',
    }
  }
  // hold_still: a fixed observation window, completed if the face was in view.
  const span = spanS(frames)
  const done = span >= HOLD_S && visible >= LIMITS.MIN_VISIBLE
  return {
    done,
    progress: clamp(span / HOLD_S, 0, 1),
    status: done ? 'Held' : !last?.face ? 'No face in view' : 'Holding',
  }
}

/** Has a timed task run its course, done or not? */
export function taskOver(id: TaskId, frames: Frame[], elapsedS: number, windowS: number = ALERTNESS.WINDOW_S): boolean {
  if (elapsedS >= taskTimeout(id, windowS)) return true
  if (id === 'hold_still') return spanS(frames) >= HOLD_S
  if (id === 'natural_gaze') return spanS(frames) >= clampWindow(windowS)
  return taskProgress(id, frames, windowS).done
}

// ---------------------------------------------------------------------------
// Alertness measures over the natural-observation window
// ---------------------------------------------------------------------------

/** Why a measurement is less than fully trustworthy. A fixed vocabulary. */
export const QUALITY_REASONS = [
  'no_observation', // the natural-observation task did not run
  'short_observation', // under MIN_VALID_S of valid eye tracking
  'below_window', // valid time under 80% of the configured window
  'very_low_frame_rate', // under MIN_FPS
  'low_frame_rate', // under GOOD_FPS: short blinks can be missed
  'missing_frames', // valid share of the window under GOOD_VALID_RATIO
  'head_turned', // many frames excluded for head yaw
  'face_too_small', // many frames excluded for face size
  'eye_asymmetry', // many frames with one eye open and one shut: occlusion, glare, a wink
  'no_closed_calibration', // no instructed eye closure to calibrate against
  'closure_not_detected', // the instructed eye closure ran but closed eyes were never seen: closures are invisible here
  'low_agreement', // EAR and blendshapes disagree on eye state
  'too_dark',
  'too_bright',
  'illumination_changed',
] as const
export type QualityReason = (typeof QUALITY_REASONS)[number]

export type Alertness = {
  /** The configured observation window, and how much of it was observed. */
  window_s: number
  observed_s: number
  /** Seconds of valid eye tracking, and as a share of the observed time. */
  valid_s: number
  valid_frame_ratio: number
  fps: number
  /** Longest stretch with no valid eye measurement, seconds. */
  max_gap_s: number
  calibration: {
    /** two_point: open and instructed-closed EAR from this session; uncalibrated: closed EAR assumed 0. */
    method: 'two_point' | 'uncalibrated'
    open_ear: number | null
    closed_ear: number | null
  }
  /** Share of valid time with the eyes at least 80% closed (EAR, calibrated). Null when insufficient. */
  perclos_p80: number | null
  /** The same from MediaPipe's eyeBlink blendshapes (≥ 0.8), as a cross-check. */
  perclos_blendshape: number | null
  /** Closures of BLINK_MAX_S or less, per minute of valid time. Null when insufficient. */
  blink_rate_per_min: number | null
  blink_count: number
  mean_blink_duration_s: number | null
  longest_closure_s: number
  /** Closures of PROLONGED_S or longer within the window. */
  prolonged_closures: number
  /** Share of valid frames where EAR and blendshapes agree on open vs closed. */
  agreement: number | null
  luma_mean: number | null
  luma_range: number | null
  quality: { grade: 'good' | 'limited' | 'insufficient'; reasons: QualityReason[] }
}

const meanEar = (f: Frame) => (f.earL !== null && f.earR !== null ? (f.earL + f.earR) / 2 : null)

function quantile(v: number[], q: number): number | null {
  if (!v.length) return null
  const s = [...v].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}

const r = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d

/**
 * PERCLOS, blinks and closures over the natural-observation window.
 *
 *   openness = clamp((EAR − EAR_closed) / (EAR_open − EAR_closed), 0, 1)
 *     EAR       mean of both eyes' EAR on the frame
 *     EAR_open  90th percentile of EAR while facing the camera and in the window
 *     EAR_closed median EAR during the instructed eye closure (two-point
 *                calibration); 0 if that task gave none ("uncalibrated")
 *   PERCLOS_P80 = Σ dt(valid, openness ≤ 0.2) / Σ dt(valid)
 * Frames are weighted by the time to the next frame, capped at
 * MAX_FRAME_GAP_S, so dropped frames neither count as open nor as closed.
 */
export function alertness(frames: Frame[], windows: TaskWindow[], windowS: number = ALERTNESS.WINDOW_S): Alertness | null {
  const nat = windows.find((w) => w.id === 'natural_gaze')
  if (!nat) return null
  const win = clampWindow(windowS)
  const inWin = frames.filter((f) => f.t >= nat.start && f.t <= nat.end)
  const observed = Math.max(spanS(inWin), (nat.end - nat.start) / 1000)
  const fps = observed > 0 ? inWin.length / observed : 0

  // Basic usability of a frame for eye measurement.
  const why = (f: Frame): 'missing' | 'yaw' | 'small' | null => {
    if (!f.face || meanEar(f) === null) return 'missing'
    if (f.yaw !== null && Math.abs(f.yaw) > ALERTNESS.MAX_YAW_DEG) return 'yaw'
    if (f.iodPx !== null && f.iodPx < ALERTNESS.MIN_IOD_PX) return 'small'
    return null
  }

  // Two-point calibration.
  const inside = (id: TaskId) => (f: Frame) => windows.some((w) => w.id === id && f.t >= w.start && f.t <= w.end)
  // The open reference is the 90th percentile of EAR while facing the camera
  // and, separately, during the window — the larger of the two. Pooling them
  // would let eyes that droop for the whole window teach the calibration
  // that drooping is "open", and hide exactly what PERCLOS is meant to see.
  const ears = (id: TaskId) => frames.filter((f) => inside(id)(f) && !why(f)).map((f) => meanEar(f) as number)
  const openRefs = [quantile(ears('face_camera'), 0.9), quantile(ears('natural_gaze'), 0.9)].filter((v): v is number => v !== null)
  const closedPool = frames
    .filter((f) => inside('eyes_closed')(f) && !why(f) && f.eyeOpen !== null && f.eyeOpen < LIMITS.CLOSED_BELOW)
    .map((f) => meanEar(f) as number)
  const openEar = openRefs.length ? Math.max(...openRefs) : null
  const closedEar = closedPool.length >= 3 ? quantile(closedPool, 0.5) : null
  const calibrated = openEar !== null && closedEar !== null && openEar - closedEar >= ALERTNESS.MIN_EAR_RANGE
  const lo = calibrated ? (closedEar as number) : 0
  const openness = (ear: number) => (openEar !== null && openEar > lo ? clamp((ear - lo) / (openEar - lo), 0, 1) : 1)

  // The blendshape cross-check gets the same two-point treatment: real closed
  // eyes score about 0.7 on eyeBlink, not 1, so a fixed "≥ 0.8" would never
  // count one (found in the browser validation).
  const blinkScores = (id: TaskId, ok: (f: Frame) => boolean) =>
    frames.filter((f) => inside(id)(f) && !why(f) && f.blink !== null && ok(f)).map((f) => f.blink as number)
  const blinkOpenRefs = [quantile(blinkScores('face_camera', () => true), 0.1), quantile(blinkScores('natural_gaze', () => true), 0.1)]
    .filter((v): v is number => v !== null)
  const blinkOpen = blinkOpenRefs.length ? Math.min(...blinkOpenRefs) : ALERTNESS.BLINK_OPEN_REF
  const blinkClosedPool = blinkScores('eyes_closed', (f) => f.eyeOpen !== null && f.eyeOpen < LIMITS.CLOSED_BELOW)
  const blinkClosedMeasured = blinkClosedPool.length >= 3 ? (quantile(blinkClosedPool, 0.5) as number) : null
  const blinkClosed =
    blinkClosedMeasured !== null && blinkClosedMeasured - blinkOpen >= 0.2 ? blinkClosedMeasured : ALERTNESS.BLINK_CLOSED_REF
  const blinkOpenness = (b: number) => clamp((blinkClosed - b) / Math.max(blinkClosed - blinkOpen, 0.05), 0, 1)

  // Per-frame validity, weights and states.
  type Row = { f: Frame; dt: number; valid: boolean; open: number | null; reason: string | null }
  // Each frame stands for the time until the next one — but never across a
  // gap: before a stall it stands only for its own frame interval, because
  // nothing is known about the eyes while no frames arrive.
  const frameInterval = 1 / Math.max(fps, 1)
  const rows: Row[] = inWin.map((f, i) => {
    const next = inWin[i + 1]
    const step = next ? (next.t - f.t) / 1000 : frameInterval
    const dt = step <= ALERTNESS.MAX_FRAME_GAP_S ? step : Math.min(frameInterval, ALERTNESS.MAX_FRAME_GAP_S)
    let reason: string | null = why(f)
    let open: number | null = null
    if (!reason) {
      const oR = openness(f.earR as number)
      const oL = openness(f.earL as number)
      if (Math.abs(oR - oL) > ALERTNESS.MAX_EYE_DIFFERENCE) reason = 'asym'
      else open = openness(meanEar(f) as number)
    }
    return { f, dt, valid: reason === null, open, reason }
  })

  const validS = rows.filter((x) => x.valid).reduce((s, x) => s + x.dt, 0)
  const share = (reason: string) => (rows.length ? rows.filter((x) => x.reason === reason).length / rows.length : 0)

  // Longest stretch without a valid measurement (missing frames, timestamp gaps).
  let maxGap = 0
  let lastValid = nat.start
  for (const x of rows) {
    if (x.valid) {
      maxGap = Math.max(maxGap, (x.f.t - lastValid) / 1000)
      lastValid = x.f.t
    }
  }
  maxGap = Math.max(maxGap, (nat.end - lastValid) / 1000)

  // Closure episodes: consecutive valid frames with openness below half,
  // never bridged across an invalid frame or a timestamp gap.
  const frameS = fps > 0 ? 1 / fps : 0
  const episodes: number[] = []
  let ep: Row[] = []
  // An episode counts as a closure only if the eyes reach at least 80% closed
  // somewhere in it (the PERCLOS P80 criterion). Lagging landmarks can hold
  // a half-lowered lid for seconds; counting that as a "closure" produced
  // spurious prolonged closures in the browser validation.
  const endEpisode = (complete: boolean) => {
    const reachedP80 = ep.some((x) => (x.open as number) <= ALERTNESS.P80_OPENNESS)
    if (ep.length && complete && reachedP80) episodes.push((ep[ep.length - 1].f.t - ep[0].f.t) / 1000 + frameS)
    ep = []
  }
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i]
    const gap = i > 0 && (x.f.t - rows[i - 1].f.t) / 1000 > ALERTNESS.MAX_FRAME_GAP_S
    if (gap) endEpisode(false)
    if (!x.valid) {
      endEpisode(false) // interrupted: duration unknown, not counted
      continue
    }
    if ((x.open as number) < ALERTNESS.CLOSURE_OPENNESS) ep.push(x)
    else endEpisode(true)
  }
  endEpisode(false) // still closed when the window ended: duration unknown

  const blinks = episodes.filter((d) => d <= LIMITS.BLINK_MAX_S)
  const valid = rows.filter((x) => x.valid)
  const p80S = valid.filter((x) => (x.open as number) <= ALERTNESS.P80_OPENNESS).reduce((s, x) => s + x.dt, 0)
  const withBlend = valid.filter((x) => x.f.blink !== null)
  const blendS = withBlend.reduce((s, x) => s + x.dt, 0)
  const blendP80S = withBlend.filter((x) => blinkOpenness(x.f.blink as number) <= ALERTNESS.P80_OPENNESS).reduce((s, x) => s + x.dt, 0)
  const agree = withBlend.filter(
    (x) => ((x.open as number) < ALERTNESS.CLOSURE_OPENNESS) === (blinkOpenness(x.f.blink as number) < ALERTNESS.CLOSURE_OPENNESS),
  ).length

  const lumas = inWin.map((f) => f.luma).filter((v): v is number => v !== null)
  const lumaMean = lumas.length ? lumas.reduce((s, v) => s + v, 0) / lumas.length : null
  const lumaRange = lumas.length ? Math.max(...lumas) - Math.min(...lumas) : null
  const agreement = withBlend.length ? agree / withBlend.length : null
  const validRatio = observed > 0 ? clamp(validS / observed, 0, 1) : 0

  const reasons: QualityReason[] = []
  if (validS < ALERTNESS.MIN_VALID_S) reasons.push('short_observation')
  if (validS < win * 0.8) reasons.push('below_window')
  if (fps < ALERTNESS.MIN_FPS) reasons.push('very_low_frame_rate')
  else if (fps < ALERTNESS.GOOD_FPS) reasons.push('low_frame_rate')
  if (validRatio < ALERTNESS.GOOD_VALID_RATIO) reasons.push('missing_frames')
  if (share('yaw') > ALERTNESS.REASON_SHARE) reasons.push('head_turned')
  if (share('small') > ALERTNESS.REASON_SHARE) reasons.push('face_too_small')
  if (share('asym') > ALERTNESS.REASON_SHARE) reasons.push('eye_asymmetry')
  // Asked to close their eyes, and closed eyes were never seen: with glasses
  // and glare, or a covered eye, MediaPipe kept reporting open eyes in the
  // browser validation. Then "0% closed" would be false reassurance, so no
  // closure measure is reported at all.
  const closureInvisible = windows.some((w) => w.id === 'eyes_closed') && closedPool.length < 3
  if (closureInvisible) reasons.push('closure_not_detected')
  else if (!calibrated) reasons.push('no_closed_calibration')
  if (agreement !== null && agreement < ALERTNESS.MIN_AGREEMENT) reasons.push('low_agreement')
  if (lumaMean !== null && lumaMean < ALERTNESS.LUMA_DARK) reasons.push('too_dark')
  if (lumaMean !== null && lumaMean > ALERTNESS.LUMA_BRIGHT) reasons.push('too_bright')
  if (lumaRange !== null && lumaRange > ALERTNESS.LUMA_RANGE) reasons.push('illumination_changed')

  const insufficient =
    reasons.includes('short_observation') || reasons.includes('very_low_frame_rate') || closureInvisible || validS <= 0
  const grade = insufficient ? 'insufficient' : reasons.length ? 'limited' : 'good'

  return {
    window_s: win,
    observed_s: r(observed, 1),
    valid_s: r(validS, 1),
    valid_frame_ratio: r(validRatio, 2),
    fps: r(fps, 1),
    max_gap_s: r(maxGap, 2),
    calibration: {
      method: calibrated ? 'two_point' : 'uncalibrated',
      open_ear: openEar === null ? null : r(openEar),
      closed_ear: calibrated ? r(closedEar as number) : null,
    },
    perclos_p80: insufficient || validS <= 0 ? null : r(p80S / validS),
    perclos_blendshape: insufficient || blendS <= 0 ? null : r(blendP80S / blendS),
    blink_rate_per_min: insufficient ? null : r(blinks.length / (validS / 60), 1),
    blink_count: blinks.length,
    mean_blink_duration_s: blinks.length ? r(blinks.reduce((s, v) => s + v, 0) / blinks.length, 2) : null,
    longest_closure_s: r(episodes.length ? Math.max(...episodes) : 0, 2),
    prolonged_closures: episodes.filter((d) => d >= LIMITS.PROLONGED_S).length,
    agreement: agreement === null ? null : r(agreement, 2),
    luma_mean: lumaMean === null ? null : r(lumaMean, 1),
    luma_range: lumaRange === null ? null : r(lumaRange, 1),
    quality: { grade, reasons },
  }
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

export type TaskWindow = { id: TaskId; start: number; end: number; completed: boolean }

export type Observation = {
  protocol: typeof PROTOCOL
  duration_s: number
  frames: number
  fps: number
  face_visible_ratio: number
  tasks: { id: TaskId; completed: boolean; seconds: number }[]
  indicators: {
    /** Short closures outside the instructed eye-closure task. */
    blinks: number
    /** Longest closure outside the instructed task, seconds. */
    longest_unprompted_eye_closure_s: number
    /** Closures of PROLONGED_S or longer outside the instructed task. */
    prolonged_unprompted_eye_closures: number
    /** Range of head turn over the session, degrees (approximate). */
    head_yaw_range_deg: number | null
    /** Range of head nod over the session, degrees (approximate). */
    head_pitch_range_deg: number | null
    /** Mean head movement during hold-still, eye-widths per second. */
    hold_still_movement: number | null
    /** Whether that movement was under STEADY_MAX (an observation-quality note). */
    hold_still_steady: boolean | null
  }
  /** Natural-observation measures, or null if that task did not run. */
  alertness: Alertness | null
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

/**
 * Summarise a session. Closures inside the instructed eye-closure window are
 * the task, not an observation, so they are left out of the indicators.
 */
export function summarize(frames: Frame[], windows: TaskWindow[], windowS: number = ALERTNESS.WINDOW_S): Observation {
  const duration = spanS(frames)
  const visible = frames.filter((f) => f.face)
  const instructed = windows.filter((w) => w.id === 'eyes_closed')
  const inInstructed = (t: number) => instructed.some((w) => t >= w.start && t <= w.end)

  // Closures, outside the instructed task. A frame with no face ends a run:
  // the eyes are unknown then, not closed.
  const runs: number[] = []
  let start: number | null = null
  let lastT = 0
  for (const f of frames) {
    const shut = closed(f) && !inInstructed(f.t)
    if (shut) {
      start ??= f.t
      lastT = f.t
    } else if (start !== null) {
      runs.push((Math.max(lastT, start) - start) / 1000 + frameGap(frames))
      start = null
    }
  }
  if (start !== null) runs.push((lastT - start) / 1000 + frameGap(frames))

  const yaws = visible.map((f) => f.yaw).filter((v): v is number => v !== null)
  const pitches = visible.map((f) => f.pitch).filter((v): v is number => v !== null)
  const range = (v: number[]) => (v.length ? round(Math.max(...v) - Math.min(...v), 1) : null)

  // Movement during hold-still: nose travel between consecutive visible frames,
  // in units of the face's own scale, per second.
  let movement: number | null = null
  const hold = windows.find((w) => w.id === 'hold_still')
  if (hold) {
    const seg = frames.filter((f) => f.t >= hold.start && f.t <= hold.end && f.face && f.nose && f.scale)
    let travel = 0
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1]
      const b = seg[i]
      travel += Math.hypot(b.nose!.x - a.nose!.x, b.nose!.y - a.nose!.y) / ((a.scale! + b.scale!) / 2)
    }
    const span = spanS(seg)
    movement = span > 0 ? round(travel / span, 3) : null
  }

  return {
    protocol: PROTOCOL,
    duration_s: round(duration, 1),
    frames: frames.length,
    fps: duration > 0 ? round(frames.length / duration, 1) : 0,
    face_visible_ratio: frames.length ? round(visible.length / frames.length) : 0,
    tasks: windows.map((w) => ({ id: w.id, completed: w.completed, seconds: round((w.end - w.start) / 1000, 1) })),
    indicators: {
      blinks: runs.filter((s) => s <= LIMITS.BLINK_MAX_S).length,
      longest_unprompted_eye_closure_s: round(runs.length ? Math.max(...runs) : 0, 1),
      prolonged_unprompted_eye_closures: runs.filter((s) => s >= LIMITS.PROLONGED_S).length,
      head_yaw_range_deg: range(yaws),
      head_pitch_range_deg: range(pitches),
      hold_still_movement: movement,
      hold_still_steady: movement === null ? null : movement < LIMITS.STEADY_MAX,
    },
    alertness: alertness(frames, windows, windowS),
  }
}

/** The typical time between frames, added to a closure's span so a single closed frame is not zero seconds. */
function frameGap(frames: Frame[]): number {
  if (frames.length < 2) return 0
  return spanS(frames) / (frames.length - 1)
}
