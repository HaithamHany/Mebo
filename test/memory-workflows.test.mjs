// Step 23: persistent per-astronaut memory and the two agent workflows.
// Continuity across restarts, isolation between astronauts, missing
// information, repeat assessments, normal and concerning scenarios, the
// separation of memory from clinical decisions, and offline operation.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMedicalService } from '../medical/service.mjs'
import { assess } from '../medical/cds/index.mjs'
import { identify, route, beginCheck, runAssessment, memoryOf } from '../medical/workflows.mjs'
import { callTool, TOOLS } from '../medical/tools.mjs'
import { route as httpRoute } from '../medical/http.mjs'
import { decideTool } from '../bridge/policy.mjs'
import { activityOf, medicalTools } from '../bridge/medical-tools.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NO = { chest_pain: 'no', short_of_breath: 'no', fainted: 'no', weak_or_lightheaded: 'no', radiating_pain: 'no', palpitations: 'no' }
const T0 = Date.parse('2026-11-15T09:00:00Z')

/** A service with its own database file, memory directory and controllable clock. */
async function world({ dir = mkdtempSync(join(tmpdir(), 'mebo-mem-')) } = {}) {
  const clock = { t: T0 }
  const svc = await createMedicalService({ path: join(dir, 'm.sqlite'), memoryDir: join(dir, 'crew'), clock: () => clock.t })
  return { svc, dir, clock, minutes: (m) => (clock.t += m * 60000) }
}

// --- continuity -----------------------------------------------------------------------

test('memory survives a restart: symptoms, assessments, concerns and follow-ups', async () => {
  const w = await world()
  beginCheck(w.svc, { crew_id: 'ms2', reported_symptom: 'I feel dizzy and my heart is racing' })
  const r = runAssessment(w.svc, 'ms2', 'cardiovascular', { ...NO, weak_or_lightheaded: 'yes' })
  assert.equal(r.level, 'urgent')
  w.svc.close()

  // A new process: new service, same files.
  const again = await createMedicalService({ path: join(w.dir, 'm.sqlite'), memoryDir: join(w.dir, 'crew'), clock: () => w.clock.t + 3600_000 })
  const m = memoryOf(again).summary('ms2')
  assert.equal(m.recent_symptoms.at(-1).text, 'I feel dizzy and my heart is racing')
  assert.equal(m.recent_assessments.at(-1).assessment_id, r.trace.assessment_id)
  assert.equal(m.recent_assessments.at(-1).dataset_sha256, r.trace.dataset_sha256)
  assert.ok(m.open_concerns.some((c) => c.rule_id === 'CV-S4' && c.level === 'urgent'))
  assert.ok(m.follow_up_prompts.some((f) => /Weakness or light-headedness \(urgent\)/.test(f.prompt)))
  again.close()
  rmSync(w.dir, { recursive: true, force: true })
})

// --- isolation ------------------------------------------------------------------------------

test('one astronaut\'s history never reaches another', async () => {
  const w = await world()
  beginCheck(w.svc, { crew_id: 'ms2', reported_symptom: 'I cannot sleep' })
  runAssessment(w.svc, 'ms2', 'sleep_fatigue', { fatigue: 5, dozed_on_task: 'yes', schedule_shift: 'no', self_harm: 'no' })
  callTool(w.svc, 'record_crew_memory', { crew_id: 'ms2', kind: 'conversation_note', text: 'Novak reported poor sleep.' })

  const cdr = memoryOf(w.svc).summary('cdr')
  assert.deepEqual([cdr.recent_symptoms, cdr.recent_conversations, cdr.recent_assessments, cdr.open_concerns], [[], [], [], []])
  assert.deepEqual(cdr.remembered_answers.sleep_fatigue, {}, 'Novak\'s answers are not Reyes\'s')
  // One file per astronaut, each naming its owner, none naming anyone else.
  const files = readdirSync(join(w.dir, 'crew'))
  assert.deepEqual(files, ['ms2.json'])
  const raw = readFileSync(join(w.dir, 'crew', 'ms2.json'), 'utf8')
  assert.equal(JSON.parse(raw).astronaut_id, 'ms2')
  for (const other of ['"cdr"', '"plt"', '"ms1"', 'REYES', 'OKAFOR', 'CHEN']) assert.ok(!raw.includes(other), other)

  // No way in by a forged id or someone else's assessment.
  assert.throws(() => memoryOf(w.svc).summary('../ms2'), (e) => e.status === 404)
  assert.throws(() => callTool(w.svc, 'record_crew_memory', { crew_id: 'nobody', kind: 'symptom', text: 'x' }), (e) => e.status === 404)
  const reyes = assess(w.svc, 'cdr', 'cardiovascular', NO)
  assert.throws(() => memoryOf(w.svc).recordAssessment('ms2', reyes), (e) => e.status === 400)
  // A file whose owner field names someone else is refused, not read.
  writeFileSync(join(w.dir, 'crew', 'plt.json'), JSON.stringify({ ...JSON.parse(raw), astronaut_id: 'ms2' }))
  assert.throws(() => memoryOf(w.svc).summary('plt'), (e) => e.status === 500)
  w.svc.close()
  rmSync(w.dir, { recursive: true, force: true })
})

// --- missing information ---------------------------------------------------------------------

test('missing information is asked for, never assumed', async () => {
  const w = await world()
  // Who is it?
  assert.equal(identify(w.svc, 'mission specialist').found, false, 'two people share that role')
  assert.equal(identify(w.svc, 'Bob').found, false)
  assert.equal(identify(w.svc, 'this is Novak').crew.id, 'ms2')
  assert.equal(identify(w.svc, 'the pilot').crew.id, 'plt')
  assert.throws(() => callTool(w.svc, 'begin_medical_check', {}), (e) => e.status === 400)
  assert.throws(() => callTool(w.svc, 'begin_medical_check', { crew_id: 'zz9' }), (e) => e.status === 404)

  // Which check? Ambiguous or unrelated complaints are handed back, not guessed.
  assert.equal(route('I feel dizzy').workflow, 'cardiovascular')
  assert.equal(route('I am exhausted and slept badly').workflow, 'sleep_fatigue')
  assert.equal(route('dizzy and exhausted').workflow, null)
  const knee = beginCheck(w.svc, { crew_id: 'cdr', reported_symptom: 'my knee hurts' })
  assert.equal(knee.workflow, null)
  assert.match(knee.message, /Ask the crew member/)

  // An assessment with unanswered questions is incomplete, and memory brings it back.
  const partial = runAssessment(w.svc, 'cdr', 'cardiovascular', { chest_pain: 'no' })
  assert.equal(partial.status, 'incomplete')
  const fu = memoryOf(w.svc).summary('cdr').follow_up_prompts
  assert.ok(fu.some((f) => /was not finished/.test(f.prompt)))
  // Finishing it closes the follow-up; the chest-pain answer was not asked twice.
  w.minutes(5)
  const plan = beginCheck(w.svc, { crew_id: 'cdr', workflow: 'cardiovascular' })
  assert.ok(!plan.questions_to_ask.some((q) => q.id === 'chest_pain'))
  assert.equal(plan.already_answered.chest_pain.value, 'no')
  const done = runAssessment(w.svc, 'cdr', 'cardiovascular', { short_of_breath: 'no', fainted: 'no', weak_or_lightheaded: 'no', radiating_pain: 'no', palpitations: 'no' })
  assert.equal(done.status, 'complete')
  assert.equal(done.answers_from_memory.chest_pain.value, 'no')
  assert.deepEqual(memoryOf(w.svc).summary('cdr').open_concerns, [])
  w.svc.close()
  rmSync(w.dir, { recursive: true, force: true })
})

// --- repeat assessments ----------------------------------------------------------------------

test('repeat assessments reuse answers only inside each question\'s window', async () => {
  const w = await world()
  runAssessment(w.svc, 'ms2', 'sleep_fatigue', { fatigue: 4, dozed_on_task: 'no', schedule_shift: 'yes', self_harm: 'no' })

  w.minutes(30)
  let plan = beginCheck(w.svc, { crew_id: 'ms2', workflow: 'sleep_fatigue' })
  assert.deepEqual(plan.questions_to_ask.map((q) => q.id), ['self_harm'], 'only the never-reused safety question is asked again')
  assert.deepEqual(Object.keys(plan.already_answered).sort(), ['dozed_on_task', 'fatigue', 'schedule_shift'])

  w.minutes(120) // fatigue (2 h window) has expired; the others have not
  plan = beginCheck(w.svc, { crew_id: 'ms2', workflow: 'sleep_fatigue' })
  assert.deepEqual(plan.questions_to_ask.map((q) => q.id), ['fatigue', 'self_harm'])

  // An answer given now beats a remembered one, and the original time is kept
  // for reused answers so a window is never stretched.
  const r = runAssessment(w.svc, 'ms2', 'sleep_fatigue', { fatigue: 2, self_harm: 'no', schedule_shift: 'no' })
  assert.equal(r.answers.fatigue, 2)
  assert.equal(r.answers.schedule_shift, 'no')
  assert.deepEqual(Object.keys(r.answers_from_memory), ['dozed_on_task'])
  const kept = JSON.parse(readFileSync(join(w.dir, 'crew', 'ms2.json'), 'utf8')).answers.sleep_fatigue
  assert.equal(kept.dozed_on_task.at, new Date(T0).toISOString(), 'reused answer keeps its original time')

  // Opting out asks everything again.
  const fresh = runAssessment(w.svc, 'ms2', 'sleep_fatigue', {}, { useRemembered: false })
  assert.equal(fresh.status, 'incomplete')
  assert.deepEqual(fresh.answers_from_memory, {})

  // Two assessments, two records — history is appended, not overwritten.
  assert.equal(memoryOf(w.svc).summary('ms2').recent_assessments.length, 3)
  w.svc.close()
  rmSync(w.dir, { recursive: true, force: true })
})

// --- the two workflows -----------------------------------------------------------------------

test('cardiovascular workflow: dizziness → history, questions, rule-based finding, follow-up', async () => {
  const w = await world()
  const plan = callTool(w.svc, 'begin_medical_check', { crew_id: 'ms2', reported_symptom: 'I feel dizzy' })
  assert.equal(plan.workflow.id, 'cardiovascular')
  // History comes from SQLite, row for row.
  const latest = w.svc.summary('ms2').metrics.heart_rate.latest
  assert.equal(plan.recent_history.source, 'medical database (SQLite)')
  assert.equal(plan.recent_history.metrics.heart_rate.latest.value, latest.value)
  assert.equal(plan.recent_history.metrics.heart_rate.latest.observation_id, latest.observation_id)
  assert.deepEqual(plan.questions_to_ask.map((q) => q.id), ['chest_pain', 'short_of_breath', 'fainted', 'weak_or_lightheaded', 'radiating_pain', 'palpitations'])
  assert.match(plan.next_step, /assess_cardiovascular/)

  // Concerning: light-headedness → the rules say urgent; memory opens a concern.
  const r = callTool(w.svc, 'assess_cardiovascular', { crew_id: 'ms2', answers: { ...NO, weak_or_lightheaded: 'yes' } })
  assert.equal(r.level, 'urgent')
  assert.ok(r.evidence.some((e) => e.rule_id === 'CV-S4'))
  assert.equal(r.memory.recorded, r.trace.assessment_id)
  assert.equal(r.memory.concerns_opened.length, 1)

  // Returning the next day: the follow-up is offered.
  w.minutes(24 * 60)
  const mem = callTool(w.svc, 'get_crew_memory', { crew_id: 'ms2' })
  assert.equal(mem.follow_up_prompts.length, 1)
  assert.match(mem.follow_up_prompts[0].prompt, /Weakness or light-headedness/)

  // Normal now: only the rules close the concern.
  const r2 = callTool(w.svc, 'assess_cardiovascular', { crew_id: 'ms2', answers: NO })
  assert.deepEqual(r2.memory.concerns_resolved.length, 1)
  assert.deepEqual(callTool(w.svc, 'get_crew_memory', { crew_id: 'ms2' }).open_concerns, [])
  w.svc.close()
  rmSync(w.dir, { recursive: true, force: true })
})

test('sleep workflow: exhaustion → sleep and mood history, questions, finding, NASA guidance', async () => {
  const w = await world()
  const plan = callTool(w.svc, 'begin_medical_check', { crew_id: 'ms2', reported_symptom: 'I am exhausted, I slept badly' })
  assert.equal(plan.workflow.id, 'sleep_fatigue')
  assert.deepEqual(Object.keys(plan.recent_history.metrics), ['sleep_duration', 'mood'])
  assert.equal(plan.recent_history.metrics.sleep_duration.latest.value, w.svc.summary('ms2').metrics.sleep_duration.latest.value)
  // Novak's low mood brings the self-harm question; the guidance is NASA's own words.
  assert.ok(plan.questions_to_ask.some((q) => q.id === 'self_harm'))
  assert.ok(plan.nasa_guidance.some((g) => g.passage_id === 'S2:risk-of-inadequate-sleep-and-irregular-schedules'))
  assert.ok(plan.nasa_guidance.every((g) => g.citation && g.url.startsWith('https://')))

  const r = callTool(w.svc, 'assess_sleep_fatigue', { crew_id: 'ms2', answers: { fatigue: 4, dozed_on_task: 'no', schedule_shift: 'no', self_harm: 'no' } })
  assert.equal(r.status, 'complete')
  assert.ok(['review', 'urgent'].includes(r.level))
  assert.ok(r.background.passages.some((p) => p.source_id === 'S2'))
  w.svc.close()
  rmSync(w.dir, { recursive: true, force: true })
})

test('normal scenario: nothing found, nothing opened', async () => {
  const w = await world()
  const r = callTool(w.svc, 'assess_cardiovascular', { crew_id: 'cdr', answers: NO })
  assert.equal(r.level, 'none')
  assert.equal(r.status, 'complete')
  assert.deepEqual(r.memory.concerns_opened, [])
  assert.deepEqual(callTool(w.svc, 'get_crew_memory', { crew_id: 'cdr' }).follow_up_prompts, [])
  w.svc.close()
  rmSync(w.dir, { recursive: true, force: true })
})

// --- memory never decides --------------------------------------------------------------------

test('memory never changes an escalation decision', async () => {
  const w = await world()
  // An open urgent concern in memory…
  runAssessment(w.svc, 'cdr', 'cardiovascular', { ...NO, weak_or_lightheaded: 'yes' })
  assert.equal(memoryOf(w.svc).summary('cdr').open_concerns[0].level, 'urgent')
  w.minutes(60)
  // …does not raise the next result: it is exactly what the rules give alone.
  const viaMemory = runAssessment(w.svc, 'cdr', 'cardiovascular', NO)
  const rulesOnly = assess(w.svc, 'cdr', 'cardiovascular', NO)
  assert.equal(viaMemory.level, rulesOnly.level)
  assert.equal(viaMemory.trace.assessment_id, rulesOnly.trace.assessment_id)
  assert.deepEqual(viaMemory.evidence, rulesOnly.evidence)
  // No tool can close a concern or delete memory by conversation.
  assert.ok(!TOOLS.some((t) => /resolve|delete|clear|forget/.test(t.name)))
  assert.throws(() => callTool(w.svc, 'record_crew_memory', { crew_id: 'cdr', kind: 'resolution', text: 'all better' }), (e) => e.status === 400)
  assert.throws(() => callTool(w.svc, 'record_crew_memory', { crew_id: 'cdr', kind: 'symptom', text: 'x'.repeat(501) }), (e) => e.status === 400)
  // Memory holds no measurement of its own.
  const raw = readFileSync(join(w.dir, 'crew', 'cdr.json'), 'utf8')
  assert.ok(!/"heart_rate"|"bp_systolic"|"value": \d{2,3}\b/.test(raw))
  w.svc.close()
  rmSync(w.dir, { recursive: true, force: true })
})

// --- offline, tools, panel -------------------------------------------------------------------

test('workflows and memory run offline', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('network access attempted')
  }
  try {
    const w = await world()
    beginCheck(w.svc, { crew_id: 'ms1', reported_symptom: 'my heart is pounding' })
    assert.ok(runAssessment(w.svc, 'ms1', 'cardiovascular', NO).trace.assessment_id)
    w.svc.close()
    rmSync(w.dir, { recursive: true, force: true })
  } finally {
    globalThis.fetch = realFetch
  }
  for (const f of ['medical/workflows.mjs', 'medical/memory/store.mjs']) {
    const code = readFileSync(join(ROOT, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(code, /\bfetch\(|node:https?|anthropic|ollama/, f)
  }
})

test('the new tools are offered to the model, admitted by the policy, and reach the panel', () => {
  for (const name of ['identify_crew_member', 'get_crew_memory', 'begin_medical_check', 'record_crew_memory']) {
    assert.ok(TOOLS.some((t) => t.name === name), name)
    assert.equal(decideTool(`mcp__mebo_medical__${name}`), true, name)
  }
  assert.ok(medicalTools(async () => null).some((t) => t.name === 'record_crew_memory'))
  const a = activityOf('assess_sleep_fatigue', { crew_id: 'ms2' }, {
    workflow: 'sleep_fatigue', level: 'review', status: 'complete', summary: 'REVIEW: x.',
    trace: { assessment_id: 'abc' }, crew: { callsign: 'NOVAK' },
  })
  assert.deepEqual([a.phase, a.workflow, a.level, a.callsign, a.assessment_id], ['end', 'sleep_fatigue', 'review', 'NOVAK', 'abc'])
  assert.equal(activityOf('assess_cardiovascular', { crew_id: 'ms2' }, null, new Error('boom')).ok, false)
})

test('HTTP: memory is readable by GET and writable only through the tools', async () => {
  const w = await world()
  httpRoute(w.svc, 'POST', '/medical/tools/begin_medical_check', { crew_id: 'plt', reported_symptom: 'I am tired' })
  httpRoute(w.svc, 'POST', '/medical/tools/assess_sleep_fatigue', { crew_id: 'plt', answers: { fatigue: 2, dozed_on_task: 'no', schedule_shift: 'no' } })
  assert.equal(httpRoute(w.svc, 'GET', '/medical/memory/plt').recent_symptoms[0].text, 'I am tired')
  assert.equal(httpRoute(w.svc, 'GET', '/medical/memory').latest.sleep_fatigue.astronaut_id, 'plt')
  assert.throws(() => httpRoute(w.svc, 'POST', '/medical/memory/plt', {}), (e) => e.status === 405)
  w.svc.close()
  rmSync(w.dir, { recursive: true, force: true })
})

// --- continuity across a real bridge restart ------------------------------------------------------

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))

function startBridge(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, MEBO_BRIDGE_PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (child.kill(), reject(new Error(`bridge did not start: ${log}`))), 15_000)
    child.stdout.on('data', (d) => {
      log += d
      const m = /bridge listening on ws:\/\/(\S+):(\d+)/.exec(log)
      if (m) {
        clearTimeout(timer)
        resolve({ child, port: Number(m[2]) })
      }
    })
    child.stderr.on('data', (d) => (log += d))
    child.on('exit', (code) => reject(new Error(`bridge exited ${code}: ${log}`)))
  })
}

function call(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, timeout: 10_000 }, (res) => {
      let out = ''
      res.on('data', (d) => (out += d))
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }))
    })
    req.on('error', reject)
    req.end(body ? JSON.stringify(body) : undefined)
  })
}

async function stop(b) {
  const gone = new Promise((r) => b.child.once('exit', r))
  b.child.kill()
  await gone
}

test('staleness counts only modules the bridge imports', async () => {
  // A throwaway module graph — a test must never touch the working tree (a
  // bridge running under --watch would restart, and a future mtime would
  // leave it reporting itself out of date).
  const { utimesSync } = await import('node:fs')
  const { moduleGraph, changedSince } = await import('../bridge/staleness.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'mebo-graph-'))
  const w = (f, s) => writeFileSync(join(dir, f), s)
  w('entry.mjs', "import { a } from './a.mjs'\nconst lazy = () => import('./lazy.mjs')\n")
  w('a.mjs', "export { b } from './b.mjs'\nexport const a = 1\n")
  w('b.mjs', 'export const b = 2\n')
  w('lazy.mjs', 'export const l = 3\n')
  w('cli.mjs', "import { a } from './a.mjs'\n") // imports bridge code, but the bridge never imports it
  try {
    const files = moduleGraph(join(dir, 'entry.mjs')).map((f) => f.slice(dir.length + 1)).sort()
    assert.deepEqual(files, ['a.mjs', 'b.mjs', 'entry.mjs', 'lazy.mjs'])
    const graph = moduleGraph(join(dir, 'entry.mjs'))
    const start = Date.now() + 10_000
    const later = new Date(start + 5_000)
    assert.equal(changedSince(graph, start), false)
    utimesSync(join(dir, 'cli.mjs'), later, later)
    assert.equal(changedSince(graph, start), false, 'a file the bridge does not load is not a change')
    utimesSync(join(dir, 'b.mjs'), later, later)
    assert.equal(changedSince(graph, start), true, 'a module two imports deep is')
    // The real bridge graph reaches the medical layer, and not the tools beside it.
    const real = moduleGraph(join(ROOT, 'bridge/server.mjs')).map((f) => f.slice(ROOT.length).replace(/\\/g, '/'))
    for (const f of ['medical/memory/store.mjs', 'medical/workflows.mjs', 'medical/cds/cardiovascular.mjs', 'medical/knowledge/search.mjs']) {
      assert.ok(real.includes(f), f)
    }
    for (const f of ['medical/cli.mjs', 'medical/server.mjs', 'scripts/knowledge-fetch.mjs']) assert.ok(!real.includes(f), f)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('conversation continuity across a bridge restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mebo-restart-'))
  const env = { MEBO_MEDICAL_DB: join(dir, 'db.sqlite'), MEBO_MEMORY_DIR: join(dir, 'crew') }
  let b = await startBridge(env)
  let id
  try {
    await call(b.port, 'POST', '/medical/tools/begin_medical_check', { crew_id: 'ms2', reported_symptom: 'I feel dizzy' })
    const r = await call(b.port, 'POST', '/medical/tools/assess_cardiovascular', { crew_id: 'ms2', answers: { ...NO, palpitations: 'yes' } })
    assert.equal(r.status, 200)
    id = r.body.trace.assessment_id
  } finally {
    await stop(b)
  }
  b = await startBridge(env)
  try {
    const m = await call(b.port, 'GET', '/medical/memory/ms2')
    assert.equal(m.body.recent_symptoms.at(-1).text, 'I feel dizzy')
    assert.equal(m.body.recent_assessments.at(-1).assessment_id, id)
    assert.ok(m.body.follow_up_prompts.some((f) => /Palpitations/.test(f.prompt)))
    assert.ok(existsSync(join(dir, 'crew', 'ms2.json')))
  } finally {
    await stop(b)
    rmSync(dir, { recursive: true, force: true })
  }
})
