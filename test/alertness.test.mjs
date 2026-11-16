/**
 * Step 26B: the alertness measures (EAR, PERCLOS, blinks, closures, quality)
 * and the observational summary.
 *
 * Every scenario is a synthetic landmark sequence with a known truth — when
 * the eyes were shut, for how long, which frames were missing — run through
 * the real src/lib/visual/observe.ts. That checks the arithmetic and the
 * quality logic exactly; how well MediaPipe's real landmarks behave on a real
 * camera is measured separately in a browser (docs/alertness-assessment.md).
 *
 * And the guarantee: camera measures alone cannot establish a diagnosis,
 * determine fitness for duty, or change an assessment or escalation level.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALERTNESS, EAR_POINTS, QUALITY_REASONS, alertness, clampWindow, eyeAspectRatio, frameFrom, instructionFor,
  summarize, taskOver, TASKS,
} from '../src/lib/visual/observe.ts'
import { QUALITY_REASONS as SERVER_REASONS, describe as describeObs, validateObservation } from '../medical/vision/observations.mjs'
import { PROTOTYPE_CUE, explain, followUps } from '../medical/vision/alertness.mjs'
import { createMedicalService } from '../medical/service.mjs'
import { route } from '../medical/http.mjs'
import { callTool } from '../medical/tools.mjs'
import { alertnessSummary, memoryOf, recordVisualObservation, runAssessment } from '../medical/workflows.mjs'
import { face, clip } from '../test-support/synthetic-face.mjs'

const FPS = 30

/**
 * A protocol-shaped session at 30 fps: face_camera (3 s, open), the natural
 * window built from `natural` segments, then the instructed eye closure (3 s
 * shut, 1 s open) for calibration. Blendshapes follow the eyes unless a
 * segment supplies its own. Returns frames and task windows.
 */
function session(natural, { fps = FPS, calibrate = true, extra = { height: 720 } } = {}) {
  const withBlend = (segs) =>
    segs.map(([s, o, b]) => [s, o, b ?? (o === null ? null : { eyeBlinkLeft: 1 - (o.eyeL ?? o.eye ?? 1), eyeBlinkRight: 1 - (o.eyeR ?? o.eye ?? 1) })])
  const head = clip(frameFrom, withBlend([[3, {}]]), { fps, extra })
  const t1 = head.length ? head[head.length - 1].t + 1000 / fps : 0
  const nat = clip(frameFrom, withBlend(natural), { fps, t0: t1, extra })
  const t2 = nat.length ? nat[nat.length - 1].t + 1000 / fps : t1
  const tail = calibrate ? clip(frameFrom, withBlend([[3, { eye: 0 }], [1, {}]]), { fps, t0: t2, extra }) : []
  const natEnd = t2 - 1000 / fps
  const windows = [
    { id: 'face_camera', start: 0, end: t1 - 1, completed: true },
    { id: 'natural_gaze', start: t1, end: natEnd, completed: true },
    ...(calibrate ? [{ id: 'eyes_closed', start: t2, end: t2 + 4000, completed: true }] : []),
  ]
  return { frames: [...head, ...nat, ...tail], windows }
}

/** `seconds` of ordinary looking with a `blinkS` closure every `every` seconds. */
function blinking(seconds, every, blinkS, closedEye = 0) {
  const segs = []
  // Each blink in the middle of its interval, so none is cut by the window's edge.
  for (let t = 0; t < seconds; t += every) {
    segs.push([(every - blinkS) / 2, {}], [blinkS, { eye: closedEye }], [(every - blinkS) / 2, {}])
  }
  return segs
}

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual}, expected ${expected} ± ${tol}`)

// --- EAR ----------------------------------------------------------------------------------

test('EAR follows Soukupová & Čech: (|p2−p6| + |p3−p5|) / (2|p1−p4|)', () => {
  const pt = (x, y) => ({ x, y })
  // Width 4, both lid gaps 1.2 → (1.2 + 1.2) / 8 = 0.3
  assert.equal(eyeAspectRatio([pt(0, 0), pt(1, -0.6), pt(3, -0.6), pt(4, 0), pt(3, 0.6), pt(1, 0.6)]).toFixed(3), '0.300')
  assert.equal(eyeAspectRatio([pt(0, 0), pt(1, 0), pt(3, 0), pt(4, 0), pt(3, 0), pt(1, 0)]), 0, 'shut')
  assert.equal(eyeAspectRatio([pt(0, 0), pt(0, 0), pt(0, 0), pt(0, 0), pt(0, 0), pt(0, 0)]), null, 'degenerate')
  // Scale- and translation-invariant: the reason it is used.
  const big = [pt(10, 10), pt(12, 8.8), pt(16, 8.8), pt(18, 10), pt(16, 11.2), pt(12, 11.2)]
  assert.equal(eyeAspectRatio(big).toFixed(3), '0.300')
})

test('EAR uses six documented MediaPipe landmarks per eye, and both eyes are measured', () => {
  assert.deepEqual(EAR_POINTS.right, [33, 160, 158, 133, 153, 144])
  assert.deepEqual(EAR_POINTS.left, [362, 385, 387, 263, 373, 380])
  const open = frameFrom(face(), null, 0, 16 / 9, { height: 720 })
  const shut = frameFrom(face({ eye: 0 }), null, 0, 16 / 9, { height: 720 })
  const half = frameFrom(face({ eye: 0.5 }), null, 0, 16 / 9, { height: 720 })
  near(open.earR, 0.3375, 0.002, 'open EAR')
  near(open.earL, 0.3375, 0.002, 'open EAR, left')
  assert.equal(shut.earR, 0)
  near(half.earR, open.earR / 2, 0.002, 'half-open EAR')
  near(open.iodPx, 0.12 * (16 / 9) * 720, 0.5, 'eye distance in pixels')
})

// --- PERCLOS, blinks, closures ------------------------------------------------------------

test('normal blinking: rate, duration and PERCLOS match the truth, quality good', () => {
  // 15 blinks a minute, 0.2 s each: PERCLOS truth 15 × 0.2 / 60 = 5%.
  const { frames, windows } = session(blinking(60, 4, 0.2))
  const a = alertness(frames, windows, 60)
  assert.equal(a.quality.grade, 'good', JSON.stringify(a.quality))
  assert.equal(a.calibration.method, 'two_point')
  near(a.blink_rate_per_min, 15, 1, 'blink rate')
  assert.equal(a.blink_count, 15)
  near(a.mean_blink_duration_s, 0.2, 0.04, 'blink duration')
  near(a.perclos_p80, 0.05, 0.015, 'PERCLOS')
  near(a.perclos_blendshape, 0.05, 0.015, 'PERCLOS from blendshapes')
  assert.equal(a.prolonged_closures, 0)
  assert.ok(a.agreement >= 0.95)
})

test('prolonged eye closure: counted as closures, not blinks, and PERCLOS rises', () => {
  // Three 2.5 s closures in a minute: PERCLOS truth 7.5 / 60 = 12.5%.
  const natural = [[10, {}], [2.5, { eye: 0 }], [15, {}], [2.5, { eye: 0 }], [15, {}], [2.5, { eye: 0 }], [12.5, {}]]
  const a = alertness(...Object.values(session(natural)), 60)
  assert.equal(a.prolonged_closures, 3)
  assert.equal(a.blink_count, 0)
  near(a.longest_closure_s, 2.5, 0.05, 'longest closure')
  near(a.perclos_p80, 0.125, 0.01, 'PERCLOS')
  assert.equal(a.quality.grade, 'good')
})

test('partly closed eyes count toward PERCLOS only at 80% closed or more', () => {
  const droop70 = alertness(...Object.values(session([[60, { eye: 0.3 }]])), 60) // 70% closed
  const droop85 = alertness(...Object.values(session([[60, { eye: 0.15 }]])), 60) // 85% closed
  assert.equal(droop70.perclos_p80, 0, '70% closed is not P80')
  assert.equal(droop85.perclos_p80, 1, '85% closed is P80')
})

test('missing frames: excluded from the denominator, never bridged, and reported', () => {
  // Every third frame has no face; blinks fall between frames.
  const natural = blinking(60, 4, 0.2)
  const { frames, windows } = session(natural)
  const holed = frames.map((f, i) => (f.t >= windows[1].start && f.t <= windows[1].end && i % 3 === 0 ? frameFrom(null, null, f.t) : f))
  const a = alertness(holed, windows, 60)
  near(a.valid_frame_ratio, 0.67, 0.04, 'valid ratio')
  assert.ok(a.quality.reasons.includes('missing_frames'))
  assert.equal(a.quality.grade, 'limited')
  assert.ok(a.blink_count < 15, `blinks interrupted by a missing frame are not counted (${a.blink_count})`)
  near(a.perclos_p80, 0.05, 0.02, 'PERCLOS over valid time only')
})

test('a camera stall is a gap, not an open or closed eye', () => {
  const { frames, windows } = session([[20, {}], [4, { eye: 0 }], [36, {}]])
  // Remove the closed stretch entirely: the camera delivered nothing.
  const s = windows[1].start + 20_000
  const stalled = frames.filter((f) => f.t < s || f.t > s + 4000)
  const a = alertness(stalled, windows, 60)
  assert.ok(a.max_gap_s >= 3.9, `gap ${a.max_gap_s}`)
  assert.equal(a.prolonged_closures, 0, 'no closure invented across the gap')
  assert.ok(a.perclos_p80 <= 0.002, `only the one closed frame before the stall counts (${a.perclos_p80})`)
})

test('partial occlusion (one eye shut, the other open) is excluded, not read as closed', () => {
  // Half the window with one eye covered — as with a hand, hair or glare.
  const a = alertness(...Object.values(session([[30, {}], [30, { eyeR: 0, eyeL: 1 }]])), 60)
  assert.ok(a.quality.reasons.includes('eye_asymmetry'), JSON.stringify(a.quality))
  assert.equal(a.perclos_p80, 0, 'occluded frames do not count as closed')
  near(a.valid_s, 30, 1.5, 'valid time')
})

test('glasses-like disagreement between EAR and blendshapes lowers quality', () => {
  // Landmarks report open eyes while the blendshape reports closed on a
  // third of frames, as reflections on lenses can cause.
  const natural = []
  for (let i = 0; i < 60; i++) natural.push([0.66, {}], [0.34, {}, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 }])
  const a = alertness(...Object.values(session(natural)), 60)
  assert.ok(a.quality.reasons.includes('low_agreement'), JSON.stringify(a))
  assert.equal(a.quality.grade, 'limited')
  assert.ok(a.perclos_blendshape > 0.25 && a.perclos_p80 === 0, 'the two methods are both reported, not merged')
})

test('lighting: dim and changing illumination are flagged', () => {
  const dim = session([[60, {}]], { extra: (_i, t) => ({ height: 720, luma: Math.round(t) % 250 < 34 ? 25 : null }) })
  const a = alertness(dim.frames, dim.windows, 60)
  assert.ok(a.quality.reasons.includes('too_dark'), JSON.stringify(a.quality))
  const changing = session([[60, {}]], { extra: (i) => ({ height: 720, luma: i % 8 === 0 ? (i % 400 < 200 ? 60 : 200) : null }) })
  const b = alertness(changing.frames, changing.windows, 60)
  assert.ok(b.quality.reasons.includes('illumination_changed'), JSON.stringify(b.quality))
  assert.equal(b.quality.grade, 'limited')
})

test('insufficient observation duration: no PERCLOS or blink rate is reported', () => {
  const a = alertness(...Object.values(session(blinking(12, 4, 0.2))), 60)
  assert.equal(a.quality.grade, 'insufficient')
  assert.ok(a.quality.reasons.includes('short_observation'))
  assert.equal(a.perclos_p80, null)
  assert.equal(a.perclos_blendshape, null)
  assert.equal(a.blink_rate_per_min, null)
  assert.match(explain({ alertness: a }), /could not measure your eyes reliably/)
})

test('without the instructed closure, EAR is uncalibrated and quality says so', () => {
  const a = alertness(...Object.values(session(blinking(60, 4, 0.2), { calibrate: false })), 60)
  assert.equal(a.calibration.method, 'uncalibrated')
  assert.equal(a.calibration.closed_ear, null)
  assert.ok(a.quality.reasons.includes('no_closed_calibration'))
  assert.equal(a.quality.grade, 'limited')
})

test('if the instructed eye closure is never seen, no closure measure is reported', () => {
  // As with glasses and glare in the browser validation: asked to close their
  // eyes, the tracker keeps reporting them open. "0% closed" would be false
  // reassurance, so PERCLOS and blink rate are withheld.
  const { frames, windows } = session(blinking(60, 4, 0.2))
  const calib = windows.find((w) => w.id === 'eyes_closed')
  const blind = frames.map((f) =>
    f.t >= calib.start && f.t <= calib.end ? frameFrom(face(), { eyeBlinkLeft: 0.1, eyeBlinkRight: 0.1 }, f.t, 16 / 9, { height: 720 }) : f,
  )
  const a = alertness(blind, windows, 60)
  assert.ok(a.quality.reasons.includes('closure_not_detected'), JSON.stringify(a.quality))
  assert.equal(a.quality.grade, 'insufficient')
  assert.equal(a.perclos_p80, null)
  assert.equal(a.blink_rate_per_min, null)
  assert.match(explain({ alertness: a }), /could not see your eyes close when I asked/)
})

test('head turned away, a small face, or a slow camera are excluded or flagged', () => {
  const turned = alertness(...Object.values(session([[30, {}], [30, { shift: 0.7 }]])), 60)
  assert.ok(turned.quality.reasons.includes('head_turned'))
  const small = alertness(...Object.values(session([[60, {}]], { extra: { height: 100 } })), 60)
  assert.ok(small.quality.reasons.includes('face_too_small'))
  assert.equal(small.quality.grade, 'insufficient', 'nothing valid to measure')
  const slow = alertness(...Object.values(session(blinking(60, 4, 0.2), { fps: 12 })), 60)
  assert.ok(slow.quality.reasons.includes('low_frame_rate'))
  const crawl = alertness(...Object.values(session([[60, {}]], { fps: 5 })), 60)
  assert.equal(crawl.quality.grade, 'insufficient')
  assert.ok(crawl.quality.reasons.includes('very_low_frame_rate'))
})

test('the observation window is configurable, bounded and spoken', () => {
  assert.equal(clampWindow(5), ALERTNESS.MIN_WINDOW_S)
  assert.equal(clampWindow(999), ALERTNESS.MAX_WINDOW_S)
  assert.equal(clampWindow(Number.NaN), 60)
  const nat = TASKS.find((t) => t.id === 'natural_gaze')
  assert.match(instructionFor(nat, 60), /for one minute, and blink as you normally would/)
  assert.match(instructionFor(nat, 30), /for thirty seconds/)
  const { frames, windows } = session([[30.2, {}]])
  const seen = frames.filter((f) => f.t >= windows[1].start && f.t <= windows[1].end)
  assert.equal(taskOver('natural_gaze', seen, 30, 30), true)
  assert.equal(taskOver('natural_gaze', seen.slice(0, 300), 10, 30), false)
  const a = alertness(frames, windows, 30)
  assert.equal(a.window_s, 30)
  assert.equal(a.quality.grade, 'good', JSON.stringify(a.quality))
})

// --- the gate and the words ---------------------------------------------------------------

test('browser and server share the quality vocabulary; the gate takes v2 and still v1', () => {
  assert.deepEqual(SERVER_REASONS, [...QUALITY_REASONS])
  const { frames, windows } = session(blinking(60, 4, 0.2))
  const o = summarize(frames, windows, 60)
  assert.deepEqual(validateObservation(o), o)
  const v1 = { ...structuredClone(o), protocol: 'face_basic_v1', tasks: o.tasks.filter((t) => t.id !== 'natural_gaze') }
  delete v1.alertness
  assert.equal(validateObservation(v1).protocol, 'face_basic_v1')
  const reject = (mutate, why) => {
    const bad = structuredClone(o)
    mutate(bad)
    assert.throws(() => validateObservation(bad), (e) => e.status === 400, why)
  }
  reject((b) => (b.alertness.fatigue = 'high'), 'no free text in alertness')
  reject((b) => (b.alertness.fit_for_duty = false), 'no fitness-for-duty field')
  reject((b) => b.alertness.quality.reasons.push('drowsy'), 'only known reasons')
  reject((b) => (b.alertness.quality.grade = 'impaired'), 'only known grades')
  reject((b) => (b.alertness.perclos_p80 = 1.5), 'PERCLOS is a share')
  reject((b) => (b.alertness.calibration.method = 'clinical'), 'only known calibration methods')
  reject((b) => Object.assign(b.alertness.quality, { grade: 'insufficient' }), 'no rates from an insufficient measurement')
  reject((b) => delete b.alertness, 'v2 requires the alertness block')
})

const ASSERTIVE =
  /(?<!whether )you (are|were|seem|appear|look|sound) (tired|drowsy|sleepy|fatigued|exhausted|impaired|unfit|fit for duty|not fit)|indicat\w* (fatigue|drowsiness|sleepiness|impairment)|(shows?|means?) (that )?you|diagnos(is|ed) (of|with)|you have (fatigue|a sleep)/i

test('explanations say what was measured, the quality and the limits — never a condition', () => {
  const cases = [
    session(blinking(60, 4, 0.2)),
    session([[10, {}], [2.5, { eye: 0 }], [15, {}], [2.5, { eye: 0 }], [30, {}]]),
    session(blinking(12, 4, 0.2)),
    session([[30, {}], [30, { eyeR: 0, eyeL: 1 }]]),
  ]
  for (const { frames, windows } of cases) {
    const o = summarize(frames, windows, 60)
    const text = explain(o)
    assert.doesNotMatch(text, ASSERTIVE, text)
    assert.doesNotMatch(describeObs(o), ASSERTIVE)
    if (o.alertness.quality.grade !== 'insufficient') {
      assert.match(text, /research measures/)
      assert.match(text, /cannot show tiredness, a diagnosis, or whether you are fit for duty/)
      assert.match(text, /measurement quality was (good|limited)/)
    }
  }
})

test('an implausibly low blink rate is not spoken as a rate', () => {
  // A measured 0 blinks a minute means quick blinks were missed (as in the
  // browser validation), not that the person stopped blinking.
  const o = summarize(...Object.values(session([[60, {}]])), 60)
  assert.equal(o.alertness.blink_rate_per_min, 0)
  const text = explain(o)
  assert.match(text, /I could not count your blinks reliably/)
  assert.doesNotMatch(text, /blinked about 0/)
  assert.match(text, /Blink counting is not yet validated/)
})

test('follow-ups: the strongest suggestion is to run the rules-based sleep and fatigue check', () => {
  const now = Date.parse('2033-08-17T12:00:00Z')
  const cued = summarize(...Object.values(session([[10, {}], [2.5, { eye: 0 }], [15, {}], [2.5, { eye: 0 }], [30, {}]])), 60)
  assert.ok(cued.alertness.perclos_p80 >= PROTOTYPE_CUE.PERCLOS || cued.alertness.prolonged_closures >= 1)
  const recent = { at: new Date(now - 3600_000).toISOString(), level: 'none' }
  const f1 = followUps({ observation: cued, selfReport: {}, lastAssessment: recent, nowMs: now })
  assert.equal(f1[0].kind, 'offer_sleep_fatigue_check')
  assert.match(f1[0].prompt, /its rules decide what happens next/)

  const poor = summarize(...Object.values(session(blinking(12, 4, 0.2))), 60)
  const f2 = followUps({ observation: poor, selfReport: { fatigue: { value: 2, age_minutes: 5 } }, lastAssessment: recent, nowMs: now })
  assert.ok(f2.some((x) => x.kind === 'repeat_camera_check'))
  assert.ok(!f2.some((x) => x.kind === 'offer_sleep_fatigue_check'), 'an insufficient camera measurement cues nothing')

  for (const x of [...f1, ...f2]) {
    assert.deepEqual(Object.keys(x).sort(), ['because', 'kind', 'prompt'])
    assert.doesNotMatch(x.prompt, ASSERTIVE)
  }
})

// --- the summary, and the guarantee -------------------------------------------------------

async function service() {
  const dir = mkdtempSync(join(tmpdir(), 'mebo-alert-'))
  return { s: await createMedicalService({ path: join(dir, 'm.sqlite'), memoryDir: join(dir, 'memory') }), dir }
}

test('the summary puts camera, sleep history, self-report and the last assessment side by side', async () => {
  const { s } = await service()
  runAssessment(s, 'ms2', 'sleep_fatigue', { fatigue: 4, dozed_on_task: 'no', schedule_shift: 'no', self_harm: 'no' })
  const rec = recordVisualObservation(s, 'ms2', summarize(...Object.values(session(blinking(60, 4, 0.2))), 60))
  assert.match(rec.explanation, /blinked about 15 times a minute/)
  assert.ok(Array.isArray(rec.follow_up) && rec.follow_up.length)

  const sum = callTool(s, 'get_alertness_summary', { crew_id: 'ms2' })
  assert.equal(sum.affects_assessment, false)
  assert.match(sum.authority, /rules engine\) is authoritative/)
  assert.match(sum.authority, /does not judge fitness for duty/)
  assert.equal(sum.camera.observation_id, rec.observation_id)
  assert.equal(sum.self_report.fatigue.value, 4)
  assert.equal(sum.sleep_history.source, 'medical database (SQLite), synthetic')
  assert.equal(sum.last_rule_assessment.level, runAssessment(s, 'ms2', 'sleep_fatigue', {}, { useRemembered: true }).level)
  assert.ok(sum.context.some((c) => /^Sleep \(medical database/.test(c)))
  assert.ok(sum.context.some((c) => /^Self-rated tiredness: 4 of 5/.test(c)))
  assert.deepEqual(sum.nasa_background.map((p) => p.passage_id), [
    'S2:risk-of-inadequate-sleep-and-irregular-schedules', 'S2:risk-of-behavioral-changes-and-psychiatric-disor',
  ])
  // No judgement of its own anywhere in it: the only level is the rules engine's, quoted.
  const keys = JSON.stringify(sum).match(/"(\w+)":/g).map((k) => k.slice(1, -2))
  for (const k of ['escalation', 'fit_for_duty', 'fitness', 'diagnosis', 'score', 'drowsy', 'impaired']) {
    assert.ok(!keys.includes(k), `summary has a "${k}" field`)
  }
  assert.deepEqual(keys.filter((k) => k === 'level').length, sum.open_concerns.length + 1, 'level only from the rules engine')
  assert.deepEqual(route(s, 'GET', '/medical/crew/ms2/alertness').camera.observation_id, rec.observation_id)
  assert.equal(alertnessSummary(s, 'ms1').camera, null, 'isolation: another crew member has none')
})

/** What decides escalation, without ids and timestamps. */
const decision = (r) => ({
  level: r.level,
  status: r.status,
  evidence: r.evidence.map((e) => [e.rule_id, e.level]),
  rules: r.rules_evaluated.map((x) => [x.id, x.result]),
  escalation: r.escalation,
})

test('camera measures alone cannot change an assessment, a concern or an escalation level', async () => {
  // The most extreme camera picture the gate accepts.
  const o = summarize(...Object.values(session([[60, { eye: 0 }]])), 60)
  o.alertness.perclos_p80 = 1
  o.alertness.perclos_blendshape = 1
  o.alertness.prolonged_closures = 30
  o.alertness.longest_closure_s = 60
  const answers = [{ fatigue: 1, dozed_on_task: 'no', schedule_shift: 'no', self_harm: 'no' }, {}]
  for (const crew of ['cdr', 'plt', 'ms1', 'ms2']) {
    for (const given of answers) {
      const plain = await service()
      const observed = await service()
      const without = runAssessment(plain.s, crew, 'sleep_fatigue', given, { useRemembered: false })
      recordVisualObservation(observed.s, crew, o)
      const memBefore = readFileSync(join(observed.dir, 'memory', `${crew}.json`), 'utf8')
      alertnessSummary(observed.s, crew) // reading it changes nothing
      assert.equal(readFileSync(join(observed.dir, 'memory', `${crew}.json`), 'utf8'), memBefore, 'the summary is read-only')
      const withObs = runAssessment(observed.s, crew, 'sleep_fatigue', given, { useRemembered: false })
      assert.deepEqual(decision(withObs), decision(without), `${crew}: the camera changed the result`)
      assert.deepEqual(
        memoryOf(observed.s).summary(crew).open_concerns.map((c) => [c.rule_id, c.level]),
        memoryOf(plain.s).summary(crew).open_concerns.map((c) => [c.rule_id, c.level]),
      )
      // And the camera alone, with no answers, never yields a complete assessment.
      if (!Object.keys(given).length) assert.equal(withObs.status, 'incomplete')
    }
  }
})
