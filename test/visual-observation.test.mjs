/**
 * The camera assessment (Step 26), below the browser:
 *   - src/lib/visual/observe.ts: landmarks → per-frame measurements, task
 *     completion, and the session summary (the real file, loaded directly);
 *   - medical/vision/observations.mjs: the gate that accepts only that
 *     summary's numeric shape;
 *   - storage in memory, the HTTP routes and the read-only tool;
 *   - and the guarantee that matters most: an observation, however it reads,
 *     never changes an assessment, a concern or an escalation level.
 *
 * The browser half (camera, MediaPipe, the panel) is exercised separately in
 * a headless browser; see docs/camera-assessment.md.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameFrom, LIMITS, PROTOCOL, summarize, taskOver, taskProgress, TASKS } from '../src/lib/visual/observe.ts'
import { describe as describeObs, PROTOCOL as SERVER_PROTOCOL, TASK_IDS, validateObservation } from '../medical/vision/observations.mjs'
import { createMedicalService } from '../medical/service.mjs'
import { route } from '../medical/http.mjs'
import { callTool, TOOL } from '../medical/tools.mjs'
import { beginCheck, recordVisualObservation, runAssessment, memoryOf } from '../medical/workflows.mjs'
import { face, clip as makeClip } from '../test-support/synthetic-face.mjs'

// --- synthetic landmarks ------------------------------------------------------------------

/** Frames at 15 fps from a list of [seconds, options|null] segments (test-support/synthetic-face.mjs). */
const clip = (segments, t0 = 0) => makeClip(frameFrom, segments, { fps: 15, t0 })

const open = {}
const shut = { eye: 0 }

// --- per-frame measurements ---------------------------------------------------------------

test('no landmarks is no face, with every measurement unknown', () => {
  const f = frameFrom(null, null, 0)
  assert.equal(f.face, false)
  assert.deepEqual([f.eyeOpen, f.yaw, f.pitch, f.roll, f.nose, f.scale], [null, null, null, null, null, null])
  assert.equal(frameFrom([], null, 0).face, false)
})

test('head orientation: facing is about 0°, a turn has a sign and a size', () => {
  const ahead = frameFrom(face(), null, 0)
  assert.ok(Math.abs(ahead.yaw) < 1, `facing yaw ${ahead.yaw}`)
  assert.ok(Math.abs(ahead.roll) < 1, `level roll ${ahead.roll}`)
  const left = frameFrom(face({ shift: 0.5 }), null, 0)
  const right = frameFrom(face({ shift: -0.5 }), null, 0)
  assert.ok(left.yaw > 20 && right.yaw < -20, `turns ${left.yaw}, ${right.yaw}`)
  assert.ok(Math.abs(left.yaw + right.yaw) < 1e-6, 'symmetric')
})

test('eye opening from blendshapes, or from the lids when blendshapes are missing', () => {
  assert.equal(frameFrom(face(), { eyeBlinkLeft: 0, eyeBlinkRight: 0 }, 0).eyeOpen, 1)
  assert.equal(frameFrom(face(), { eyeBlinkLeft: 1, eyeBlinkRight: 1 }, 0).eyeOpen, 0)
  assert.ok(frameFrom(face(open), null, 0).eyeOpen > 0.5, 'open lids read open')
  assert.ok(frameFrom(face(shut), null, 0).eyeOpen < LIMITS.CLOSED_BELOW, 'shut lids read closed')
})

// --- the guided tasks ---------------------------------------------------------------------

test('face_camera needs a facing face for 1.5 s; a missing face does not count', () => {
  assert.equal(taskProgress('face_camera', clip([[2, open]])).done, true)
  assert.equal(taskProgress('face_camera', clip([[1, open]])).done, false)
  assert.equal(taskProgress('face_camera', clip([[3, null]])).done, false)
  assert.equal(taskProgress('face_camera', clip([[3, null]])).status, 'No face in view')
  assert.equal(taskProgress('face_camera', clip([[3, { shift: 0.6 }]])).done, false, 'turned away')
})

test('eyes_closed needs a 2 s closure and then open eyes', () => {
  assert.equal(taskProgress('eyes_closed', clip([[1, open], [2.5, shut], [0.5, open]])).done, true)
  assert.equal(taskProgress('eyes_closed', clip([[1, open], [2.5, shut]])).done, false, 'still closed')
  assert.equal(taskProgress('eyes_closed', clip([[1, open], [2.5, shut]])).status, 'You can open your eyes')
  assert.equal(taskProgress('eyes_closed', clip([[1, open], [1, shut], [1, open]])).done, false, 'too short')
  // No face while "closed" is unknown, not closed.
  assert.equal(taskProgress('eyes_closed', clip([[1, open], [3, null], [1, open]])).done, false)
})

test('head_turn needs both directions', () => {
  assert.equal(taskProgress('head_turn', clip([[1, { shift: 0.5 }], [1, { shift: -0.5 }]])).done, true)
  const one = taskProgress('head_turn', clip([[2, { shift: 0.5 }]]))
  assert.equal(one.done, false)
  assert.equal(one.progress, 0.5)
})

test('hold_still is a 5 s window, completed only with the face in view', () => {
  assert.equal(taskProgress('hold_still', clip([[5.2, open]])).done, true)
  assert.equal(taskProgress('hold_still', clip([[2, open], [3.2, null]])).done, false)
  assert.equal(taskOver('hold_still', clip([[5.2, null]]), 5.2), true, 'the window ends either way')
  assert.equal(taskOver('face_camera', clip([[1, null]]), 30), true, 'timeouts end a task')
})

// --- the summary --------------------------------------------------------------------------

function session() {
  // face_camera 0-2 s, eyes_closed 2-6 s (instructed closure), head_turn 6-8 s,
  // hold_still 8-13.5 s with an unprompted 2.5 s closure and a blink at 0.2 s.
  const frames = clip([
    [2, open],
    [1, open], [2.5, shut], [0.5, open],
    [1, { shift: 0.5 }], [1, { shift: -0.5 }],
    [1, open], [0.2, shut], [1, open], [2.5, shut], [0.8, open],
  ])
  const at = (s) => s * 1000
  const windows = [
    { id: 'face_camera', start: at(0), end: at(2), completed: true },
    { id: 'eyes_closed', start: at(2), end: at(6), completed: true },
    { id: 'head_turn', start: at(6), end: at(8), completed: true },
    { id: 'hold_still', start: at(8), end: at(13.5), completed: true },
  ]
  return summarize(frames, windows)
}

test('summary: instructed closures are the task, unprompted ones are observations', () => {
  const o = session()
  assert.equal(o.protocol, PROTOCOL)
  assert.equal(o.tasks.length, 4)
  assert.ok(o.tasks.every((t) => t.completed))
  assert.equal(o.face_visible_ratio, 1)
  assert.equal(o.indicators.prolonged_unprompted_eye_closures, 1, 'the hold-still closure, not the instructed one')
  assert.ok(o.indicators.longest_unprompted_eye_closure_s >= 2.4 && o.indicators.longest_unprompted_eye_closure_s < 3)
  assert.equal(o.indicators.blinks, 1)
  assert.ok(o.indicators.head_yaw_range_deg > 40, `yaw range ${o.indicators.head_yaw_range_deg}`)
  assert.equal(o.indicators.hold_still_steady, true, 'the face did not move')
})

test('summary: a moving face is reported as moving; an empty room as no face', () => {
  const moving = clip(Array.from({ length: 30 }, (_, i) => [0.2, { dx: (i % 2) * 0.03 }]))
  const m = summarize(moving, [{ id: 'hold_still', start: 0, end: 6000, completed: true }])
  assert.equal(m.indicators.hold_still_steady, false, `movement ${m.indicators.hold_still_movement}`)

  const empty = summarize(clip([[12, null]]), [{ id: 'face_camera', start: 0, end: 12000, completed: false }])
  assert.equal(empty.face_visible_ratio, 0)
  assert.equal(empty.indicators.blinks, 0)
  assert.equal(empty.indicators.head_yaw_range_deg, null)
  assert.deepEqual(validateObservation(empty), empty, 'a no-face session is still a valid observation')
})

// --- the gate -----------------------------------------------------------------------------

test('browser and server agree on the protocol and its tasks', () => {
  assert.equal(SERVER_PROTOCOL, PROTOCOL)
  assert.deepEqual(TASK_IDS, TASKS.map((t) => t.id))
})

test('the server accepts the summary shape and nothing else', () => {
  const o = session()
  assert.deepEqual(validateObservation(o), o)
  const reject = (mutate, why) => {
    const bad = structuredClone(o)
    mutate(bad)
    assert.throws(() => validateObservation(bad), (e) => e.status === 400, why)
  }
  reject((b) => (b.diagnosis = 'fatigue'), 'no free-text fields')
  reject((b) => (b.indicators.assessment = 'urgent'), 'no extra indicators')
  reject((b) => (b.indicators.blinks = 'many'), 'numbers are numbers')
  reject((b) => (b.face_visible_ratio = 3), 'ratios are 0..1')
  reject((b) => (b.tasks[0].id = 'pupil_response'), 'only known tasks')
  reject((b) => b.tasks.push({ ...b.tasks[0] }), 'no duplicate tasks')
  reject((b) => (b.protocol = 'other'), 'one protocol')
  reject((b) => (b.tasks[0].note = 'looked tired'), 'no notes on tasks')
  assert.throws(() => validateObservation(null), (e) => e.status === 400)
})

test('the plain description states what the camera saw, and no condition', () => {
  const text = describeObs(session())
  assert.match(text, /Face in view 100%/)
  assert.match(text, /1 of 2 s or longer/)
  assert.doesNotMatch(text, /fatigu|tired|drows|sleepy|\bill\b|illness|disease|depress|anxi|stress|pain|diagnos|cardi|mood/i)
})

// --- storage, routes, tools ---------------------------------------------------------------

async function service() {
  const dir = mkdtempSync(join(tmpdir(), 'mebo-visual-'))
  return createMedicalService({ path: join(dir, 'm.sqlite'), memoryDir: join(dir, 'memory') })
}

test('an observation is filed for one crew member only, and read back through route and tool', async () => {
  const s = await service()
  const posted = route(s, 'POST', '/medical/visual-observations', { crew_id: 'ms2', observation: session() })
  const rec = posted.recorded
  assert.match(rec.observation_id, /^vis-/)
  assert.equal(rec.astronaut_id, 'ms2')
  assert.equal(rec.affects_assessment, false)
  assert.match(rec.description, /Face in view/)

  const listed = route(s, 'GET', '/medical/crew/ms2/visual-observations')
  assert.equal(listed.observations[0].observation_id, rec.observation_id)
  assert.equal(route(s, 'GET', '/medical/crew/ms1/visual-observations').found, false, 'isolation')

  const viaTool = callTool(s, 'get_visual_observations', { crew_id: 'ms2' })
  assert.equal(viaTool.observations.length, 1)
  assert.equal(viaTool.affects_assessment, false)
  assert.equal(memoryOf(s).summary('ms2').recent_visual_observations.length, 1)

  assert.throws(() => route(s, 'POST', '/medical/visual-observations', { crew_id: 'nobody', observation: session() }), (e) => e.status === 404)
  assert.throws(() => route(s, 'POST', '/medical/visual-observations', { crew_id: 'ms2', observation: { protocol: PROTOCOL } }), (e) => e.status === 400)
})

test('the latest camera check across the crew is readable for the panel after a reload', async () => {
  const s = await service()
  assert.deepEqual(route(s, 'GET', '/medical/visual-observations'), { latest: null })
  route(s, 'POST', '/medical/visual-observations', { crew_id: 'ms1', observation: session() })
  await new Promise((r) => setTimeout(r, 5))
  const second = route(s, 'POST', '/medical/visual-observations', { crew_id: 'ms2', observation: session() }).recorded
  const { latest } = route(s, 'GET', '/medical/visual-observations')
  assert.equal(latest.observation_id, second.observation_id, 'the newest, whoever it belongs to')
  assert.equal(latest.callsign, 'NOVAK')
  assert.match(latest.description, /Face in view/)
  assert.equal(typeof latest.explanation, 'string')
  assert.equal(latest.affects_assessment, false)
  assert.throws(() => route(s, 'POST', '/medical/visual-observations/latest', {}), (e) => e.status === 405 || e.status === 404)
})

test('no model can file an observation: recording is not a tool', async () => {
  const s = await service()
  assert.equal(TOOL.record_visual_observation, undefined)
  assert.throws(() => callTool(s, 'record_visual_observation', { crew_id: 'ms2' }), (e) => e.status === 404)
  // And the read tool takes no observation data.
  assert.throws(() => callTool(s, 'get_visual_observations', { crew_id: 'ms2', observation: session() }), (e) => e.status === 400)
})

test('a check offers a recent observation as supplementary context only', async () => {
  const s = await service()
  const before = beginCheck(s, { crew_id: 'cdr', workflow: 'sleep_fatigue' })
  assert.equal(before.supplementary_observations.camera_observation, null)
  recordVisualObservation(s, 'cdr', session())
  const after = beginCheck(s, { crew_id: 'cdr', workflow: 'sleep_fatigue' })
  assert.match(after.supplementary_observations.camera_observation.description, /Face in view/)
  assert.equal(after.supplementary_observations.affects_assessment, false)
  assert.deepEqual(after.questions_to_ask, before.questions_to_ask, 'the questions are the rules\', unchanged')
})

// --- the guarantee ------------------------------------------------------------------------

/** What decides escalation, without ids and timestamps. */
const decision = (r) => ({
  level: r.level,
  status: r.status,
  evidence: r.evidence.map((e) => [e.rule_id, e.level]),
  rules: r.rules_evaluated.map((x) => [x.id, x.result]),
  escalation: r.escalation,
  missing: r.missing.map((m) => m.id ?? m.label),
})

test('observations never change an assessment, a concern or an escalation level', async () => {
  // The most alarming-looking observation the gate allows.
  const alarming = structuredClone(session())
  alarming.tasks = alarming.tasks.map((t) => ({ ...t, completed: false }))
  alarming.face_visible_ratio = 0.3
  alarming.indicators.prolonged_unprompted_eye_closures = 40
  alarming.indicators.longest_unprompted_eye_closure_s = 300
  alarming.indicators.hold_still_steady = false

  const answers = {
    cardiovascular: { chest_pain: 'no', short_of_breath: 'no', fainted: 'no', weak_or_lightheaded: 'no', radiating_pain: 'no', palpitations: 'no' },
    sleep_fatigue: { fatigue: 2, dozed_on_task: 'no', schedule_shift: 'no', self_harm: 'no' },
  }
  for (const crew of ['cdr', 'plt', 'ms1', 'ms2']) {
    for (const wf of ['cardiovascular', 'sleep_fatigue']) {
      for (const given of [answers[wf], {}]) {
        const plain = await service()
        const observed = await service()
        const without = runAssessment(plain, crew, wf, given, { useRemembered: false })
        const concernsBefore = memoryOf(observed).summary(crew).open_concerns
        recordVisualObservation(observed, crew, alarming)
        assert.deepEqual(memoryOf(observed).summary(crew).open_concerns, concernsBefore, 'filing opens no concern')
        const withObs = runAssessment(observed, crew, wf, given, { useRemembered: false })
        assert.deepEqual(decision(withObs), decision(without), `${crew}/${wf}: an observation changed the result`)
        assert.deepEqual(
          memoryOf(observed).summary(crew).open_concerns.map((c) => [c.rule_id, c.level]),
          memoryOf(plain).summary(crew).open_concerns.map((c) => [c.rule_id, c.level]),
          `${crew}/${wf}: concerns differ`,
        )
      }
    }
  }
})
