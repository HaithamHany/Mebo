/**
 * Step 26C: from camera check to sleep and fatigue assessment.
 *
 * The pure parts of the interview (src/lib/visual/interview.ts) — reading a
 * spoken answer, and what MeBo says — and the workflow itself driven through
 * the same local HTTP routes the console uses (begin_medical_check →
 * assess_sleep_fatigue → record_crew_memory → /alertness), with no language
 * model. The browser half (voice, buttons, the centre view, reloads) is
 * exercised in a headless browser; see docs/camera-assessment.md.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONSENT_QUESTION, cameraGapNote, conversationNote, isSkip, parseAnswer, parseConsent, parseScale, parseYesNo, spokenResult,
} from '../src/lib/visual/interview.ts'
import { createMedicalService } from '../medical/service.mjs'
import { route } from '../medical/http.mjs'
import { memoryOf, runAssessment } from '../medical/workflows.mjs'

// --- reading answers ----------------------------------------------------------------------

test('yes/no answers are read by fixed rules, and anything unclear is not guessed', () => {
  for (const t of ['yes', 'Yeah.', 'yes I have', 'I have', 'I did, once', 'correct']) assert.equal(parseYesNo(t), 'yes', t)
  for (const t of ['no', 'Nope', 'not really', 'never', 'I have not', "I haven't", 'no, never']) assert.equal(parseYesNo(t), 'no', t)
  for (const t of ["I don't know", 'maybe', 'not sure', 'yes and no', '', 'the weather is nice']) assert.equal(parseYesNo(t), null, t)
})

test('scale answers: digits, words or the scale\'s own labels — and never the echo of the question', () => {
  const q = { min: 1, max: 5, labels: { 1: 'fully rested', 2: 'a little tired', 3: 'moderately tired', 4: 'very tired', 5: 'exhausted' } }
  assert.equal(parseScale('3', q), 3)
  assert.equal(parseScale('about a four', q), 4)
  assert.equal(parseScale('I am exhausted', q), 5)
  assert.equal(parseScale('very tired', q), 4)
  assert.equal(parseScale('moderately tired I think', q), 3)
  assert.equal(parseScale('seven', q), null, 'off the scale')
  assert.equal(parseScale('9', q), null)
  assert.equal(parseScale("I don't know", q), null)
  // The question itself, heard back through the microphone, lists every option.
  assert.equal(parseScale('one is fully rested two a little tired three moderately tired', q), null)
  assert.equal(parseScale('two or three', q), null, 'two values is not an answer')
})

test('consent and skipping', () => {
  for (const t of ['yes', 'sure', 'go ahead', 'okay', 'of course']) assert.equal(parseConsent(t), 'yes', t)
  for (const t of ['no', 'not now', 'later', 'no thanks']) assert.equal(parseConsent(t), 'no', t)
  assert.equal(parseConsent('hmm'), null)
  assert.ok(isSkip('skip this one') && isSkip("I'd rather not say") && !isSkip('yes'))
  assert.equal(parseAnswer({ id: 'x', text: '', type: 'yes_no' }, 'yes'), 'yes')
  assert.equal(parseAnswer({ id: 'x', text: '', type: 'scale', min: 1, max: 5 }, '2'), 2)
})

// --- what MeBo says -----------------------------------------------------------------------

const ASSERTIVE = /you (are|seem|look) (tired|drowsy|fatigued|unfit|fit for duty)|camera (shows|showed|found) (that )?you|diagnos(is|ed) (of|with)/i

test('MeBo speaks the rules engine\'s guidance first, word for word, and the camera as supplementary', () => {
  const r = {
    status: 'complete', level: 'review', summary: 'REVIEW: …',
    evidence: [{ title: 'Sleep under six hours', level: 'review' }, { title: 'Sleep below the adult consensus', level: 'monitor' }],
    missing: [],
    escalation: { level: 'review', guidance: 'Report to the crew medical officer at the next opportunity.' },
  }
  const said = spokenResult(r)
  assert.ok(said.startsWith('Here is the result of your sleep and fatigue check. Report to the crew medical officer at the next opportunity.'))
  assert.match(said, /The main findings are: sleep under six hours\./)
  assert.doesNotMatch(said, /adult consensus/, 'monitor-level items are not called main findings')
  assert.match(said, /camera measures were supplementary, and they did not change this result/)
  assert.doesNotMatch(said, ASSERTIVE)
})

test('with a fatigue concern (Step 26D), the guidance still comes first and the concern follows it', () => {
  const r = {
    status: 'complete', level: 'review', summary: 'REVIEW: …',
    evidence: [{ title: 'Sleep under six hours', level: 'review' }],
    missing: [],
    escalation: { level: 'review', guidance: 'Report to the crew medical officer at the next opportunity.' },
  }
  const concern = 'Putting your sleep, your answers and the camera together, my fatigue concern is high.'
  const said = spokenResult(r, concern)
  assert.ok(said.startsWith('Here is the result of your sleep and fatigue check. Report to the crew medical officer at the next opportunity.'))
  assert.ok(said.indexOf(concern) > said.indexOf('Report to the crew medical officer'))
  assert.match(said, /camera measures did not change that result/)
  assert.ok(said.endsWith(concern))
  const note = conversationNote({
    cameraQuality: 'good', observationId: 'vis-1', declined: false,
    result: { level: 'review', status: 'complete', trace: { assessment_id: 'abc' } },
    concern: { level: 'high', raised_by_camera: true },
  })
  assert.match(note, /REVIEW, complete \(abc\); camera-supported fatigue concern high \(raised by the camera\)\.$/)
})

test('an incomplete assessment says what is missing and that it is not reassurance', () => {
  const said = spokenResult({
    status: 'incomplete', level: 'none', summary: '', evidence: [],
    missing: [{ label: 'Falling asleep during a task', required: true }, { label: 'Schedule change', required: false }],
    escalation: { level: 'none', guidance: 'No escalation needed now.', incomplete: 'Assessment incomplete: obtain the missing items listed and repeat the assessment. The absence of a concern in an incomplete assessment is not reassurance.' },
  })
  assert.match(said, /Some answers are missing: falling asleep during a task\./)
  assert.doesNotMatch(said, /schedule change/, 'only required items are named')
  assert.match(said, /is not reassurance/)
})

test('when the camera could not contribute, MeBo says it is not reassurance and goes on', () => {
  for (const reason of ['insufficient', 'no_face', 'denied', 'error']) {
    const note = cameraGapNote(reason)
    assert.match(note, /the camera adds nothing to this check/)
    assert.match(note, /does not mean everything is fine/)
    assert.match(note, /questions will still/)
  }
  assert.match(CONSENT_QUESTION, /Is that all right\?$/)
})

test('the memory note is short, factual and links the camera check and the assessment', () => {
  const done = conversationNote({ cameraQuality: 'limited', observationId: 'vis-abc', declined: false, result: { level: 'review', status: 'complete', trace: { assessment_id: 'as-1' } } })
  assert.equal(done, 'Camera check (limited, vis-abc) followed by the sleep and fatigue check: REVIEW, complete (as-1).')
  const declined = conversationNote({ cameraQuality: 'insufficient', observationId: null, declined: true, result: null })
  assert.match(declined, /declined the sleep and fatigue questions afterwards, so no assessment was made/)
  assert.ok(done.length <= 500 && declined.length <= 500)
})

// --- the workflow through the local API ---------------------------------------------------

async function service() {
  const dir = mkdtempSync(join(tmpdir(), 'mebo-follow-'))
  return { s: await createMedicalService({ path: join(dir, 'm.sqlite'), memoryDir: join(dir, 'memory') }), dir }
}

/** The camera summary the page posts (shape only; values arbitrary but valid). */
const OBS = {
  protocol: 'face_alertness_v2', duration_s: 100, frames: 1700, fps: 17, face_visible_ratio: 0.98,
  tasks: [{ id: 'face_camera', completed: true, seconds: 2 }, { id: 'natural_gaze', completed: true, seconds: 60 }],
  indicators: { blinks: 1, longest_unprompted_eye_closure_s: 0.3, prolonged_unprompted_eye_closures: 0, head_yaw_range_deg: 40, head_pitch_range_deg: 6, hold_still_movement: 0.05, hold_still_steady: true },
  alertness: {
    window_s: 60, observed_s: 60, valid_s: 59, valid_frame_ratio: 0.98, fps: 17, max_gap_s: 0.1,
    calibration: { method: 'two_point', open_ear: 0.37, closed_ear: 0.02 }, perclos_p80: 0.9, perclos_blendshape: 0.9,
    blink_rate_per_min: 1, blink_count: 1, mean_blink_duration_s: 0.3, longest_closure_s: 50, prolonged_closures: 3,
    agreement: 0.98, luma_mean: 90, luma_range: 20, quality: { grade: 'limited', reasons: ['low_frame_rate'] },
  },
}

test('camera check → questions → rules-based assessment → memory, all through the local API', async () => {
  const { s, dir } = await service()
  // 1. The camera check is filed.
  const obs = route(s, 'POST', '/medical/visual-observations', { crew_id: 'cdr', observation: OBS }).recorded
  // 2. The questions still to ask, from the rules engine.
  const begun = route(s, 'POST', '/medical/tools/begin_medical_check', { crew_id: 'cdr', workflow: 'sleep_fatigue' })
  const ids = begun.questions_to_ask.map((q) => q.id)
  assert.ok(ids.includes('fatigue') && ids.includes('dozed_on_task'), ids.join(','))
  // 3. Answers as the interview reads them.
  const answers = {}
  const said = { fatigue: 'about a two', dozed_on_task: 'no, never', schedule_shift: 'I have not', self_harm: 'no' }
  for (const q of begun.questions_to_ask) answers[q.id] = parseAnswer(q, said[q.id])
  assert.equal(answers.fatigue, 2)
  // 4. The rules engine's assessment.
  const result = route(s, 'POST', '/medical/tools/assess_sleep_fatigue', { crew_id: 'cdr', answers })
  assert.equal(result.status, 'complete')
  // 5. The note, and the combined summary.
  route(s, 'POST', '/medical/tools/record_crew_memory', {
    crew_id: 'cdr', kind: 'conversation_note',
    text: conversationNote({ cameraQuality: 'limited', observationId: obs.observation_id, declined: false, result }),
  })
  const summary = route(s, 'GET', '/medical/crew/cdr/alertness')
  assert.equal(summary.last_rule_assessment.assessment_id, result.trace.assessment_id)
  assert.equal(summary.camera.observation_id, obs.observation_id)

  const mem = JSON.parse(readFileSync(join(dir, 'memory', 'cdr.json'), 'utf8'))
  assert.equal(mem.observations.length, 1)
  assert.equal(mem.assessments.at(-1).assessment_id, result.trace.assessment_id)
  assert.match(mem.conversations.at(-1).text, new RegExp(`${obs.observation_id}.*${result.trace.assessment_id}`))
  assert.equal(mem.answers.sleep_fatigue.fatigue.value, 2, 'answers kept for reuse within their windows')

  // A second check soon after asks nothing already answered.
  const again = route(s, 'POST', '/medical/tools/begin_medical_check', { crew_id: 'cdr', workflow: 'sleep_fatigue' })
  assert.ok(!again.questions_to_ask.some((q) => q.id === 'fatigue'))
})

test('the camera (here, an extreme picture) never changes the follow-up assessment', async () => {
  const answers = { fatigue: 2, dozed_on_task: 'no', schedule_shift: 'no', self_harm: 'no' }
  for (const crew of ['cdr', 'plt', 'ms1', 'ms2']) {
    const a = await service()
    const b = await service()
    route(b.s, 'POST', '/medical/visual-observations', { crew_id: crew, observation: OBS })
    const without = runAssessment(a.s, crew, 'sleep_fatigue', answers, { useRemembered: false })
    const withCam = route(b.s, 'POST', '/medical/tools/assess_sleep_fatigue', { crew_id: crew, answers, use_remembered_answers: false })
    assert.equal(withCam.level, without.level, crew)
    assert.deepEqual(withCam.evidence.map((e) => e.rule_id), without.evidence.map((e) => e.rule_id), crew)
    assert.deepEqual(withCam.escalation, without.escalation, crew)
  }
})

test('declined: nothing is assessed; incomplete: the rules engine says so', async () => {
  const { s } = await service()
  // Declined: only a note is filed; no assessment exists for the follow-up.
  route(s, 'POST', '/medical/tools/record_crew_memory', {
    crew_id: 'plt', kind: 'conversation_note', text: conversationNote({ cameraQuality: 'good', observationId: null, declined: true, result: null }),
  })
  assert.equal(memoryOf(s).summary('plt').recent_assessments.length, 0)
  // Incomplete: only some answers given (others skipped).
  const r = route(s, 'POST', '/medical/tools/assess_sleep_fatigue', { crew_id: 'ms1', answers: { fatigue: 3 } })
  assert.equal(r.status, 'incomplete')
  assert.match(r.escalation.incomplete, /not reassurance/)
  assert.ok(memoryOf(s).summary('ms1').open_concerns.some((c) => c.kind === 'incomplete'), 'an unfinished check is followed up later')
})
