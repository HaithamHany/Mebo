/**
 * Step 26D: the camera-supported fatigue concern.
 *
 * The classification (medical/vision/fatigue-concern.mjs) on its own, with
 * hand-built assessments and camera summaries, then end to end through the
 * medical service, tool, HTTP route and memory. And the guarantees: the rules
 * engine is unchanged, the camera can raise the concern but never lower it,
 * and an unreliable camera observation is set aside, never read as normal.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frameFrom, summarize } from '../src/lib/visual/observe.ts'
import { CONCERN_LEVELS, FLOOR_FROM_RULES, THRESHOLDS, cameraUsability, classifyFatigueConcern } from '../medical/vision/fatigue-concern.mjs'
import { createMedicalService } from '../medical/service.mjs'
import { route } from '../medical/http.mjs'
import { callTool } from '../medical/tools.mjs'
import { memoryOf, recordVisualObservation, runAssessment } from '../medical/workflows.mjs'
import { clip } from '../test-support/synthetic-face.mjs'

// --- inputs ---------------------------------------------------------------------------

const assessment = (level, status = 'complete', rule_ids = []) => ({
  assessment_id: 'a1', at: '2026-11-15T10:00:00.000Z', level, status, rule_ids, missing: status === 'incomplete' ? ['Self-rated fatigue'] : [],
})

/** A camera summary with the alertness fields the classifier reads. */
const cam = ({ perclos = 0.03, prolonged = 0, longest = 0.4, grade = 'good', reasons = [], face = 0.98 } = {}) => ({
  face_visible_ratio: face,
  alertness: {
    perclos_p80: perclos, prolonged_closures: prolonged, longest_closure_s: longest, valid_s: 58,
    quality: { grade, reasons },
  },
})

const classify = (a, o, extra = {}) =>
  classifyFatigueConcern({ assessment: a, observation: o, observationId: o ? 'vis-1' : null, observationAgeMin: o ? 2 : null, ...extra })

// --- the classification -------------------------------------------------------------------

test('normal observations: the concern follows the rules engine, and the camera is listed as within limits', () => {
  const r = classify(assessment('none'), cam())
  assert.equal(r.level, 'low')
  assert.equal(r.raised_by_camera, false)
  assert.equal(r.camera.status, 'used')
  assert.deepEqual(r.contributors.filter((c) => c.source === 'camera').map((c) => c.effect), ['within', 'within', 'within'])
  assert.match(r.explanation, /within the prototype limits/)
  assert.match(r.spoken, /my fatigue concern is low/)
  assert.equal(r.clinical_escalation_unchanged, true)
})

test('elevated PERCLOS raises the concern, and says exactly which indicator did', () => {
  const r = classify(assessment('none'), cam({ perclos: 0.22 }))
  assert.equal(r.level, 'moderate')
  assert.equal(r.rules_floor, 'low')
  assert.equal(r.raised_by_camera, true)
  const perclos = r.contributors.find((c) => c.indicator.startsWith('PERCLOS'))
  assert.equal(perclos.effect, 'raised')
  assert.equal(perclos.value, '22%')
  assert.equal(perclos.threshold, '≥ 15%')
  assert.match(perclos.basis, /prototype/)
  assert.equal(r.contributors.find((c) => c.indicator.startsWith('Sustained')).effect, 'within')
  assert.match(r.spoken, /The camera raised the concern/)
})

test('high needs both camera indicators at good quality; limited quality caps the camera at moderate', () => {
  assert.equal(classify(assessment('none'), cam({ perclos: 0.2, prolonged: 2, longest: 3.1 })).level, 'high')
  assert.equal(classify(assessment('none'), cam({ perclos: 0.2, prolonged: 2, longest: 3.1, grade: 'limited', reasons: ['low_frame_rate'] })).level, 'moderate')
  assert.equal(classify(assessment('none'), cam({ prolonged: 1, longest: 2.4 })).level, 'moderate', 'one sustained closure alone')
  // Exactly at the threshold counts.
  assert.equal(classify(assessment('none'), cam({ perclos: THRESHOLDS.PERCLOS_ELEVATED.value })).level, 'moderate')
  assert.equal(classify(assessment('none'), cam({ perclos: THRESHOLDS.PERCLOS_ELEVATED.value - 0.001 })).level, 'low')
})

test('the camera never lowers the rules engine: every rules level against every camera picture', () => {
  const cameras = [null, cam(), cam({ perclos: 0.2 }), cam({ perclos: 0.3, prolonged: 3, longest: 4 }), cam({ grade: 'insufficient', reasons: ['too_dark'] })]
  for (const level of Object.keys(FLOOR_FROM_RULES)) {
    for (const status of ['complete', 'incomplete']) {
      for (const o of cameras) {
        const r = classify(assessment(level, status), o)
        const floor = r.rules_floor
        if (floor !== 'indeterminate') {
          assert.ok(CONCERN_LEVELS.indexOf(r.level) >= CONCERN_LEVELS.indexOf(floor), `${level}/${status}: ${r.level} < ${floor}`)
        }
        if (level === 'urgent' || level === 'emergency') assert.equal(r.level, 'high')
      }
    }
  }
})

test('conflicting evidence: said plainly, and resolved toward more concern', () => {
  // Camera elevated, answers and sleep fine.
  const up = classify(assessment('none'), cam({ perclos: 0.25 }), { selfReport: { fatigue: { value: 1, age_minutes: 1 } } })
  assert.equal(up.level, 'moderate')
  assert.equal(up.conflicts.length, 1)
  assert.match(up.conflicts[0], /camera raised the concern/)
  assert.match(up.spoken, /point different ways/)
  // Answers serious, camera normal: stays high.
  const down = classify(assessment('urgent', 'complete', ['FT-DOZE']), cam())
  assert.equal(down.level, 'high')
  assert.match(down.conflicts[0], /does not lower that concern/)
  assert.equal(down.contributors.find((c) => c.rule_id === 'FT-DOZE').source, 'self_report')
  assert.equal(down.contributors.find((c) => c.rule_id === 'FT-DOZE').effect, 'sets_floor')
})

test('missing camera data: the concern rests on the rules alone and the camera is marked excluded', () => {
  const r = classify(assessment('review', 'complete', ['SL-SHORT']), null)
  assert.equal(r.level, 'moderate')
  assert.equal(r.camera.status, 'missing')
  assert.equal(r.contributors.find((c) => c.source === 'camera').effect, 'excluded')
  assert.match(r.spoken, /camera was not used.*not a sign that everything is fine/)
  // An old observation is missing too, in effect.
  const old = classifyFatigueConcern({ assessment: assessment('none'), observation: cam({ perclos: 0.4 }), observationAgeMin: 180 })
  assert.equal(old.camera.status, 'stale')
  assert.equal(old.level, 'low', 'a stale camera cannot raise it')
})

test('poor tracking: insufficient quality or no face is rejected, never treated as normal', () => {
  for (const o of [
    cam({ grade: 'insufficient', reasons: ['closure_not_detected'], perclos: null }),
    cam({ grade: 'insufficient', reasons: ['missing_frames', 'head_turned'], perclos: 0.01 }),
    { face_visible_ratio: 0, alertness: null },
  ]) {
    const r = classify(assessment('none'), o)
    assert.equal(r.camera.status, 'rejected')
    assert.equal(r.camera.supports_level, null, 'a rejected camera supports no level, not "low"')
    assert.ok(!r.contributors.some((c) => c.source === 'camera' && c.effect === 'within'))
  }
  // Incomplete rules plus an unusable camera: indeterminate, not low.
  const r = classify(assessment('none', 'incomplete'), cam({ grade: 'insufficient', reasons: ['too_dark'], perclos: null }))
  assert.equal(r.level, 'indeterminate')
  assert.match(r.spoken, /cannot say how tired you are/)
})

test('incomplete rules with a normal camera stay indeterminate; a reliable elevated camera can still raise it', () => {
  assert.equal(classify(assessment('none', 'incomplete'), cam()).level, 'indeterminate')
  assert.equal(classify(assessment('monitor', 'incomplete'), cam()).level, 'indeterminate')
  assert.equal(classify(null, cam()).level, 'indeterminate', 'no assessment at all')
  const r = classify(assessment('none', 'incomplete'), cam({ perclos: 0.2 }))
  assert.equal(r.level, 'moderate')
  assert.equal(r.raised_by_camera, true)
  // A rules finding at review or above stands even when incomplete.
  assert.equal(classify(assessment('review', 'incomplete'), cam()).level, 'moderate')
})

test('extreme values are set aside as implausible, not read as high or as normal', () => {
  for (const o of [cam({ perclos: 1, prolonged: 30, longest: 60 }), cam({ perclos: 0.6 }), cam({ perclos: 0.1, prolonged: 1, longest: 40 })]) {
    const u = cameraUsability(o, 1)
    assert.equal(u.status, 'rejected')
    assert.equal(u.implausible, true)
    const r = classify(assessment('none'), o)
    assert.equal(r.level, 'low', 'falls back to the rules, which ask directly about falling asleep')
    assert.equal(r.raised_by_camera, false)
    assert.match(r.explanation, /plausibly/)
  }
  // Just inside the plausible range is used.
  assert.equal(cameraUsability(cam({ perclos: 0.5, prolonged: 3, longest: 15 }), 1).status, 'used')
})

test('every threshold is labelled; the record carries method, thresholds, references and limitations', () => {
  const r = classify(assessment('none'), cam())
  for (const [k, t] of Object.entries(r.thresholds)) assert.match(t.basis, /prototype/, `${k} not labelled prototype`)
  assert.equal(r.method, 'camera_supported_fatigue_concern_v1')
  assert.ok(r.references.some((x) => x.kind === 'NASA'))
  assert.ok(r.references.some((x) => x.id === 'Abe2023' && x.url.startsWith('https://doi.org/')))
  assert.ok(r.limitations.some((l) => /none is validated/.test(l)))
  // No diagnosis or fitness judgement in the vocabulary.
  const keys = JSON.stringify(r).match(/"(\w+)":/g).map((k) => k.slice(1, -2))
  for (const k of ['diagnosis', 'fit_for_duty', 'fitness', 'drowsy', 'impaired', 'escalation']) assert.ok(!keys.includes(k), k)
  assert.match(r.spoken, /not a diagnosis/)
})

// --- end to end ---------------------------------------------------------------------------

async function service() {
  const dir = mkdtempSync(join(tmpdir(), 'mebo-concern-'))
  return { s: await createMedicalService({ path: join(dir, 'm.sqlite'), memoryDir: join(dir, 'memory') }), dir }
}

/** A real, validated camera observation (open eyes, calibrated), with chosen alertness numbers. */
function observation(set = {}) {
  const fps = 30
  const seg = (s, o) => [s, o, { eyeBlinkLeft: 1 - (o.eye ?? 1), eyeBlinkRight: 1 - (o.eye ?? 1) }]
  const head = clip(frameFrom, [seg(3, {})], { fps, extra: { height: 720 } })
  const t1 = head.at(-1).t + 1000 / fps
  const nat = clip(frameFrom, [seg(60, {})], { fps, t0: t1, extra: { height: 720 } })
  const t2 = nat.at(-1).t + 1000 / fps
  const tail = clip(frameFrom, [seg(3, { eye: 0 }), seg(1, {})], { fps, t0: t2, extra: { height: 720 } })
  const o = summarize(
    [...head, ...nat, ...tail],
    [
      { id: 'face_camera', start: 0, end: t1 - 1, completed: true },
      { id: 'natural_gaze', start: t1, end: t2 - 1000 / fps, completed: true },
      { id: 'eyes_closed', start: t2, end: t2 + 4000, completed: true },
    ],
    60,
  )
  Object.assign(o.alertness, set)
  return o
}

const BENIGN = { fatigue: 1, dozed_on_task: 'no', schedule_shift: 'no', self_harm: 'no' }

test('end to end: assessment, camera and memory combine; the tool files evidence, provenance and references', async () => {
  const { s, dir } = await service()
  const rec = recordVisualObservation(s, 'cdr', observation({ perclos_p80: 0.2, perclos_blendshape: 0.2, prolonged_closures: 2, longest_closure_s: 3.2 }))
  const a = runAssessment(s, 'cdr', 'sleep_fatigue', BENIGN)
  assert.equal(a.level, 'review', 'the synthetic scenario has short sleep')

  const c = callTool(s, 'assess_fatigue_concern', { crew_id: 'cdr', assessment_id: a.trace.assessment_id })
  assert.equal(c.rules_floor, 'moderate')
  assert.equal(c.level, 'high', 'both camera indicators, good quality')
  assert.equal(c.raised_by_camera, true)
  assert.equal(c.provenance.assessment_id, a.trace.assessment_id)
  assert.equal(c.provenance.observation_id, rec.observation_id)
  assert.equal(c.provenance.assessment_inputs_sha256, a.trace.inputs_sha256)
  assert.deepEqual(c.contributors.filter((x) => x.via === 'rules_engine').map((x) => x.rule_id), a.evidence.map((e) => e.rule_id))
  assert.ok(c.contributors.every((x) => x.via !== 'rules_engine' || x.source === 'sleep_history' || x.source === 'mood'))
  assert.match(c.references.find((x) => x.kind === 'NASA').citation, /NASA Human Research Program/)
  assert.match(c.notice, /never reduce it/)

  // Filed in memory, and readable after a reload.
  const mem = JSON.parse(readFileSync(join(dir, 'memory', 'cdr.json'), 'utf8'))
  assert.equal(mem.fatigue_concerns.at(-1).concern_id, c.concern_id)
  assert.equal(mem.fatigue_concerns.at(-1).affects_assessment, false)
  assert.equal(route(s, 'GET', '/medical/crew/cdr/fatigue-concern').latest.concern_id, c.concern_id)
  assert.equal(memoryOf(s).summary('cdr').recent_fatigue_concerns.at(-1).level, 'high')
  assert.equal(route(s, 'GET', '/medical/crew/plt/fatigue-concern').latest, null, 'isolation')

  // The assessment in memory is exactly what the rules engine said.
  assert.equal(mem.assessments.at(-1).level, 'review')
  assert.deepEqual(mem.concerns.filter((x) => x.status === 'open').map((x) => x.rule_id).sort(), ['SL-BASELINE', 'SL-SHORT'])
})

test('end to end: a normal camera does not lower, and no camera leaves the rules level', async () => {
  const { s } = await service()
  recordVisualObservation(s, 'ms1', observation())
  const a = runAssessment(s, 'ms1', 'sleep_fatigue', BENIGN)
  const c = callTool(s, 'assess_fatigue_concern', { crew_id: 'ms1' })
  assert.equal(c.level, 'moderate')
  assert.equal(c.raised_by_camera, false)
  assert.equal(c.rules_assessment.assessment_id, a.trace.assessment_id, 'defaults to the latest assessment')
  assert.equal(c.camera.status, 'used')

  const none = callTool(s, 'assess_fatigue_concern', { crew_id: 'plt' })
  assert.equal(none.level, 'indeterminate', 'no assessment and no camera')
  assert.throws(() => callTool(s, 'assess_fatigue_concern', { crew_id: 'cdr', assessment_id: 'nope' }), (e) => e.status === 404)
  assert.throws(() => callTool(s, 'assess_fatigue_concern', { crew_id: 'cdr', perclos: 0.9 }), (e) => e.status === 400, 'no measures from the caller')
})

/** What decides escalation, without ids and timestamps. */
const decision = (r) => ({
  level: r.level, status: r.status,
  evidence: r.evidence.map((e) => [e.rule_id, e.level]),
  rules: r.rules_evaluated.map((x) => [x.id, x.result]),
  escalation: r.escalation,
})

test('the clinical rules engine is unchanged: same rules source, same results with or without the concern', async () => {
  // The ruleset file is not touched by Step 26D.
  const src = readFileSync(new URL('../medical/cds/sleep-fatigue.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  assert.equal(createHash('sha256').update(src).digest('hex').slice(0, 16), RULESET_SHA)

  for (const crew of ['cdr', 'plt', 'ms1', 'ms2']) {
    const plain = await service()
    const combined = await service()
    const without = runAssessment(plain.s, crew, 'sleep_fatigue', BENIGN, { useRemembered: false })
    recordVisualObservation(combined.s, crew, observation({ perclos_p80: 0.3, prolonged_closures: 4, longest_closure_s: 5 }))
    const first = runAssessment(combined.s, crew, 'sleep_fatigue', BENIGN, { useRemembered: false })
    const c = callTool(combined.s, 'assess_fatigue_concern', { crew_id: crew })
    assert.equal(c.level, 'high')
    const again = runAssessment(combined.s, crew, 'sleep_fatigue', BENIGN, { useRemembered: false })
    assert.deepEqual(decision(first), decision(without), `${crew}: camera changed the result`)
    assert.deepEqual(decision(again), decision(without), `${crew}: the concern changed a later result`)
    assert.deepEqual(
      memoryOf(combined.s).summary(crew).open_concerns.map((x) => [x.rule_id, x.level]),
      memoryOf(plain.s).summary(crew).open_concerns.map((x) => [x.rule_id, x.level]),
      'the concern opens no clinical concern',
    )
  }
})

/** sha256 (first 16 hex) of medical/cds/sleep-fatigue.mjs with LF line endings, as of Step 26D. */
const RULESET_SHA = '7aeeefb4ee229550'

test('a check uses only its own camera observation: "none" ignores an earlier one, an id picks that one', async () => {
  const { s } = await service()
  const earlier = recordVisualObservation(s, 'plt', observation({ perclos_p80: 0.3, prolonged_closures: 3, longest_closure_s: 4 }))
  runAssessment(s, 'plt', 'sleep_fatigue', BENIGN)
  // This check had no camera (skipped or stopped): the earlier elevated reading must not count.
  const none = callTool(s, 'assess_fatigue_concern', { crew_id: 'plt', observation_id: 'none' })
  assert.equal(none.camera.status, 'missing')
  assert.equal(none.raised_by_camera, false)
  assert.equal(none.level, 'moderate')
  const named = callTool(s, 'assess_fatigue_concern', { crew_id: 'plt', observation_id: earlier.observation_id })
  assert.equal(named.camera.status, 'used')
  assert.equal(named.level, 'high')
  assert.throws(() => callTool(s, 'assess_fatigue_concern', { crew_id: 'plt', observation_id: 'vis-nope' }), (e) => e.status === 404)
})
