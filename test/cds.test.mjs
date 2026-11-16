// MeBo clinical decision support: rules, workflows, traceability, and the
// tool/API surface. No language model and no network are involved.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createMedicalService } from '../medical/service.mjs'
import { evaluate, ESCALATION, LEVELS, BASES, ALL_REFERENCES, INCOMPLETE_GUIDANCE } from '../medical/cds/engine.mjs'
import { assess, questions, WORKFLOWS } from '../medical/cds/index.mjs'
import { CARDIOVASCULAR } from '../medical/cds/cardiovascular.mjs'
import { SLEEP_FATIGUE } from '../medical/cds/sleep-fatigue.mjs'
import { route } from '../medical/http.mjs'
import { callTool, TOOLS } from '../medical/tools.mjs'
import { decideTool } from '../bridge/policy.mjs'
import { medicalTools } from '../bridge/medical-tools.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Each service gets its own memory directory: tools that assess also file the
// result in conversational memory, which must never land in the real memory/.
const memory = () => createMedicalService({ path: ':memory:', memoryDir: mkdtempSync(join(tmpdir(), 'mebo-cds-mem-')) })

// --- hand-built contexts, for exact rule boundaries ----------------------------

let nextId = 1
function reading(value, extra = {}) {
  return {
    value, observation_id: value === null ? null : nextId++, z: null, mean7: null, z7: null, trend14: null,
    trend14_se: null, baseline: { mean: 0, sd: 1, n: 28, method: 'preflight' },
    last_reading: value === null ? null : { value, age_hours: 2, stale: false }, ...extra,
  }
}

function cardioCtx({ hr = 64, sbp = 116, dbp = 74, answers = NO_SYMPTOMS, ...data } = {}) {
  return {
    crew: { id: 'test' }, mission: { mission_day: 1, environment: 'microgravity (interplanetary transit)' },
    data: { heart_rate: reading(hr, data.heart_rate), bp_systolic: reading(sbp, data.bp_systolic), bp_diastolic: reading(dbp, data.bp_diastolic) },
    answers, dataset_sha256: 'test',
  }
}

function sleepCtx({ sleep = 7.5, mean7 = 7.4, z7 = 0.1, trend14 = 0, trend14_se = 0.1, mood7 = 4, moodZ7 = 0, answers = CALM } = {}) {
  return {
    crew: { id: 'test' }, mission: { mission_day: 1 },
    data: {
      sleep_duration: reading(sleep, { mean7, z7, trend14, trend14_se }),
      mood: reading(4, { mean7: mood7, z7: moodZ7 }),
    },
    answers, dataset_sha256: 'test',
  }
}

const NO_SYMPTOMS = { chest_pain: 'no', short_of_breath: 'no', fainted: 'no', weak_or_lightheaded: 'no', radiating_pain: 'no', palpitations: 'no' }
const CALM = { fatigue: 2, dozed_on_task: 'no', schedule_shift: 'no' }
const fired = (r) => r.evidence.map((e) => e.rule_id).sort()

// --- normal -----------------------------------------------------------------------

test('normal: unremarkable values and answers give no concern, complete', () => {
  const c = evaluate(CARDIOVASCULAR, cardioCtx())
  assert.equal(c.status, 'complete')
  assert.equal(c.level, 'none')
  assert.deepEqual(fired(c), [])
  assert.equal(c.summary, 'No concerns identified by the rules.')
  assert.equal(c.escalation.guidance, ESCALATION.none)
  assert.ok(c.rules_evaluated.every((r) => r.result === false || r.missing), 'every evaluable rule evaluated false')

  const s = evaluate(SLEEP_FATIGUE, sleepCtx())
  assert.equal(s.status, 'complete')
  assert.equal(s.level, 'none')
  assert.ok(!s.missing.some((m) => m.input === 'answers.self_harm'), 'self-harm question not asked when mood is fine')
})

test('normal: a real crew member with unremarkable data and no symptoms', async () => {
  const svc = await memory()
  const r = assess(svc, 'cdr', 'cardiovascular', NO_SYMPTOMS)
  assert.equal(r.status, 'complete')
  assert.equal(r.level, 'none', r.summary)
  svc.close()
})

// --- concerning ---------------------------------------------------------------------

test('concerning: NEWS2 heart-rate and systolic bands, exactly at their edges', () => {
  const cases = [
    [{ hr: 40 }, 'CV-HR-N3', 'urgent'], [{ hr: 41 }, 'CV-HR-N1', 'monitor'], [{ hr: 50 }, 'CV-HR-N1', 'monitor'],
    [{ hr: 91 }, 'CV-HR-N1', 'monitor'], [{ hr: 110 }, 'CV-HR-N1', 'monitor'], [{ hr: 111 }, 'CV-HR-N2', 'review'],
    [{ hr: 130 }, 'CV-HR-N2', 'review'], [{ hr: 131 }, 'CV-HR-N3', 'urgent'],
    [{ sbp: 90 }, 'CV-SBP-N3', 'urgent'], [{ sbp: 91 }, 'CV-SBP-N2', 'review'], [{ sbp: 100 }, 'CV-SBP-N2', 'review'],
    [{ sbp: 101 }, 'CV-SBP-N1', 'monitor'], [{ sbp: 110 }, 'CV-SBP-N1', 'monitor'],
  ]
  for (const [input, rule, level] of cases) {
    const r = evaluate(CARDIOVASCULAR, cardioCtx(input))
    assert.deepEqual(fired(r), [rule], JSON.stringify(input))
    assert.equal(r.level, level, JSON.stringify(input))
  }
  // In-band values fire nothing.
  for (const hr of [51, 90]) assert.deepEqual(fired(evaluate(CARDIOVASCULAR, cardioCtx({ hr }))), [])
  assert.deepEqual(fired(evaluate(CARDIOVASCULAR, cardioCtx({ sbp: 111 }))), [])
})

test('concerning: ACC/AHA blood-pressure categories fire one at a time', () => {
  const at = (sbp, dbp) => fired(evaluate(CARDIOVASCULAR, cardioCtx({ sbp, dbp })))
  assert.deepEqual(at(119, 79), [])
  assert.deepEqual(at(130, 70), ['CV-BP-STAGE1'])
  assert.deepEqual(at(120, 80), ['CV-BP-STAGE1'])
  assert.deepEqual(at(140, 70), ['CV-BP-STAGE2'])
  assert.deepEqual(at(125, 90), ['CV-BP-STAGE2'])
  assert.deepEqual(at(180, 110), ['CV-BP-STAGE2'], '180 is not above 180')
  const severe = evaluate(CARDIOVASCULAR, cardioCtx({ sbp: 185, dbp: 100 }))
  assert.deepEqual(fired(severe), ['CV-BP-SEVERE'])
  assert.equal(severe.level, 'urgent')
  assert.match(evaluate(CARDIOVASCULAR, cardioCtx({ sbp: 145, dbp: 85 })).concerns[0].text, /single reading is not a diagnosis/)
})

test('concerning: baseline deviation and trends, with noise rejected', () => {
  const base = { mean: 62, sd: 3, n: 56, method: 'preflight' }
  const dev = evaluate(CARDIOVASCULAR, cardioCtx({ heart_rate: { z: 2.4, baseline: base } }))
  assert.deepEqual(fired(dev), ['CV-HR-BASELINE'])
  assert.equal(dev.level, 'monitor')
  const rising = evaluate(CARDIOVASCULAR, cardioCtx({ heart_rate: { trend14: 3, trend14_se: 1 } }))
  assert.deepEqual(fired(rising), ['CV-HR-TREND'])
  const noisy = evaluate(CARDIOVASCULAR, cardioCtx({ heart_rate: { trend14: 3, trend14_se: 2 } }))
  assert.deepEqual(fired(noisy), [], 'a slope inside twice its standard error is noise')
})

test('concerning: sleep, fatigue and mood', () => {
  assert.deepEqual(fired(evaluate(SLEEP_FATIGUE, sleepCtx({ mean7: 6.5 }))), ['SL-CONSENSUS'])
  assert.deepEqual(fired(evaluate(SLEEP_FATIGUE, sleepCtx({ mean7: 5.5 }))), ['SL-CONSENSUS', 'SL-SHORT'])
  assert.deepEqual(fired(evaluate(SLEEP_FATIGUE, sleepCtx({ z7: -2.5 }))), ['SL-BASELINE'])
  assert.deepEqual(fired(evaluate(SLEEP_FATIGUE, sleepCtx({ trend14: -0.5, trend14_se: 0.1 }))), ['SL-TREND'])
  assert.deepEqual(fired(evaluate(SLEEP_FATIGUE, sleepCtx({ trend14: -0.5, trend14_se: 0.3 }))), [])
  assert.deepEqual(fired(evaluate(SLEEP_FATIGUE, sleepCtx({ answers: { ...CALM, fatigue: 4 } }))), ['FT-HIGH'])
  assert.deepEqual(fired(evaluate(SLEEP_FATIGUE, sleepCtx({ answers: { ...CALM, schedule_shift: 'yes' } }))), ['SC-SHIFT'])

  // Low mood: fires, and makes the self-harm question required.
  const low = evaluate(SLEEP_FATIGUE, sleepCtx({ mood7: 2 }))
  assert.deepEqual(fired(low), ['MD-LOW'])
  assert.equal(low.status, 'incomplete')
  assert.ok(low.missing.some((m) => m.input === 'answers.self_harm' && m.required))
  const answered = evaluate(SLEEP_FATIGUE, sleepCtx({ mood7: 2, answers: { ...CALM, self_harm: 'no' } }))
  assert.equal(answered.status, 'complete')
})

// --- urgent symptoms ------------------------------------------------------------------

test('urgent and emergency symptoms escalate, whatever the measurements say', () => {
  const sym = (answers) => evaluate(CARDIOVASCULAR, cardioCtx({ answers: { ...NO_SYMPTOMS, ...answers } }))
  for (const [q, rule, level] of [
    ['chest_pain', 'CV-S1', 'emergency'], ['short_of_breath', 'CV-S2', 'emergency'], ['fainted', 'CV-S3', 'emergency'],
    ['weak_or_lightheaded', 'CV-S4', 'urgent'], ['radiating_pain', 'CV-S5', 'urgent'], ['palpitations', 'CV-S6', 'review'],
  ]) {
    const r = sym({ [q]: 'yes' })
    assert.deepEqual(fired(r), [rule], q)
    assert.equal(r.level, level, q)
    assert.equal(r.escalation.guidance, ESCALATION[level])
  }
  // Severe blood pressure with symptoms is an emergency; both rules are reported.
  const r = evaluate(CARDIOVASCULAR, cardioCtx({ sbp: 190, dbp: 100, answers: { ...NO_SYMPTOMS, chest_pain: 'yes' } }))
  assert.deepEqual(fired(r), ['CV-BP-EMERGENCY', 'CV-S1'])
  assert.equal(r.level, 'emergency')
  assert.match(r.escalation.guidance, /Alert the crew medical officer immediately/)

  // An emergency stands even with every other question unanswered.
  const partial = evaluate(CARDIOVASCULAR, cardioCtx({ answers: { chest_pain: 'yes' } }))
  assert.equal(partial.level, 'emergency')
  assert.equal(partial.status, 'incomplete')

  const sl = (answers) => evaluate(SLEEP_FATIGUE, sleepCtx({ answers: { ...CALM, ...answers } }))
  assert.equal(sl({ dozed_on_task: 'yes' }).level, 'urgent')
  assert.equal(sl({ fatigue: 5 }).level, 'urgent')
  const harm = evaluate(SLEEP_FATIGUE, sleepCtx({ mood7: 2, answers: { ...CALM, self_harm: 'yes' } }))
  assert.equal(harm.level, 'emergency')
  assert.ok(fired(harm).includes('MD-SELFHARM'))
})

// --- missing and stale data -----------------------------------------------------------

test('missing data: never "no concern", always listed with a reason and an action', () => {
  const r = evaluate(CARDIOVASCULAR, cardioCtx({ hr: null, answers: {} }))
  assert.equal(r.status, 'incomplete')
  assert.match(r.summary, /^INCOMPLETE/)
  assert.equal(r.escalation.incomplete, INCOMPLETE_GUIDANCE)
  const hr = r.missing.find((m) => m.input === 'data.heart_rate.value')
  assert.equal(hr.reason, 'no reading recorded')
  assert.equal(hr.action, 'Take a resting heart-rate reading.')
  for (const q of ['chest_pain', 'short_of_breath', 'fainted', 'weak_or_lightheaded', 'radiating_pain']) {
    assert.ok(r.missing.some((m) => m.input === `answers.${q}` && m.required), q)
  }
  assert.ok(r.missing.some((m) => m.input === 'answers.palpitations' && !m.required))
  // Rules that need heart rate were not evaluable, not "false".
  for (const id of ['CV-HR-N1', 'CV-HR-N2', 'CV-HR-N3']) {
    assert.equal(r.rules_evaluated.find((e) => e.id === id).result, null)
  }
  assert.ok(r.next_assessments.some((n) => n.text === 'Take a resting heart-rate reading.'))
})

test('stale data: a 3-day-old reading is not used as the current value', async () => {
  const svc = await memory()
  // Chen's wearable has been offline for the last three days.
  const r = assess(svc, 'ms1', 'cardiovascular', NO_SYMPTOMS)
  assert.equal(r.status, 'incomplete')
  assert.notEqual(r.level, 'none')
  const hr = r.missing.find((m) => m.input === 'data.heart_rate.value')
  assert.match(hr.reason, /no current reading — the last one is \d+(\.\d+)? h old/)
  assert.equal(r.observations.heart_rate.value, null)
  assert.equal(r.observations.heart_rate.last_reading.stale, true)
  assert.ok(!r.evidence.some((e) => Object.keys(e.inputs).includes('data.heart_rate.value')), 'no rule read the stale value')
  svc.close()
})

// --- reproducible, traceable, offline -------------------------------------------------

test('assessments are reproducible down to their id', async () => {
  const svc = await memory()
  const a = assess(svc, 'ms2', 'sleep_fatigue', { fatigue: 4, dozed_on_task: 'no', self_harm: 'no' })
  const b = assess(svc, 'ms2', 'sleep_fatigue', { fatigue: 4, dozed_on_task: 'no', self_harm: 'no' })
  assert.deepEqual(a, b)
  const c = assess(svc, 'ms2', 'sleep_fatigue', { fatigue: 5, dozed_on_task: 'no', self_harm: 'no' })
  assert.notEqual(c.trace.assessment_id, a.trace.assessment_id)
  // A fresh database from the same scenario gives the same record.
  const svc2 = await memory()
  assert.deepEqual(assess(svc2, 'ms2', 'sleep_fatigue', { fatigue: 4, dozed_on_task: 'no', self_harm: 'no' }), a)
  svc.close()
  svc2.close()
})

test('assessments trace to rules, references and database rows', async () => {
  const svc = await memory()
  const r = assess(svc, 'ms2', 'sleep_fatigue', { fatigue: 4, dozed_on_task: 'no', self_harm: 'no' })
  assert.ok(r.evidence.length > 0)
  assert.equal(r.trace.dataset_sha256, svc.provenance().dataset_sha256)
  assert.equal(r.trace.ruleset, 'sleep_fatigue@1')
  const ids = new Set(svc.history('ms2', 'sleep_duration').observations.map((o) => o.id))
  for (const moodId of svc.history('ms2', 'mood').observations.map((o) => o.id)) ids.add(moodId)
  for (const e of r.evidence) {
    for (const ref of e.refs) assert.ok(ALL_REFERENCES[ref.id] && ref.url.startsWith('https://'), ref.id)
    for (const id of e.observation_ids) assert.ok(ids.has(id), `observation ${id} exists`)
    assert.ok(BASES[e.basis])
  }
  assert.ok(r.evidence.some((e) => e.observation_ids.length > 0), 'data-driven rules name their rows')
  svc.close()
})

test('assessments run offline and without any language model', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('network access attempted')
  }
  try {
    const svc = await memory()
    assert.equal(assess(svc, 'cdr', 'cardiovascular', NO_SYMPTOMS).status, 'complete')
    assert.ok(assess(svc, 'ms2', 'sleep_fatigue', { fatigue: 3, dozed_on_task: 'no', self_harm: 'no' }).evidence.length)
    svc.close()
  } finally {
    globalThis.fetch = realFetch
  }
  // Nothing in the medical layer imports a model SDK or reaches the network.
  const files = []
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.mjs')) files.push(p)
    }
  }
  walk(join(ROOT, 'medical'))
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    // Imports only: comments may name Ollama as the future target, and
    // server.mjs legitimately imports node:http to *serve* on loopback.
    const imports = src.split('\n').filter((l) => /^\s*import\b|\bimport\(/.test(l)).join('\n')
    assert.doesNotMatch(imports, /@anthropic-ai|claude-agent-sdk|ollama|openai|node:https|node:net|undici/, f)
    // No outbound requests from code (outside comments).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(code, /\bfetch\(|http\.request\(|http\.get\(/, f)
  }
})

// --- rule hygiene and documentation ----------------------------------------------------

test('every rule is well-formed, referenced and documented', () => {
  const doc = readFileSync(join(ROOT, 'docs/clinical-decision-support.md'), 'utf8')
  const seen = new Set()
  for (const w of Object.values(WORKFLOWS)) {
    for (const r of w.rules) {
      assert.ok(!seen.has(r.id), `duplicate rule id ${r.id}`)
      seen.add(r.id)
      assert.ok(LEVELS.includes(r.level) && r.level !== 'none', `${r.id} level`)
      assert.ok(BASES[r.basis], `${r.id} basis`)
      assert.ok(r.refs.length > 0, `${r.id} has references`)
      for (const ref of r.refs) assert.ok(ALL_REFERENCES[ref], `${r.id} cites unknown ${ref}`)
      assert.ok(r.requires.length > 0 && typeof r.when === 'function')
      // The documented table row carries the same level, basis and refs.
      const row = doc.split('\n').find((l) => l.startsWith(`| \`${r.id}\` |`))
      assert.ok(row, `${r.id} is documented`)
      const cells = row.split('|').map((x) => x.trim())
      assert.equal(cells[3], r.level, `${r.id} documented level`)
      assert.equal(cells[4], r.basis, `${r.id} documented basis`)
      assert.equal(cells[5], r.refs.join(', '), `${r.id} documented refs`)
    }
  }
  for (const id of ['C1', 'C2', 'C3', 'C4']) assert.ok(doc.includes(ALL_REFERENCES[id].url), `docs cite ${id}`)
})

test('answers are validated, never interpreted', async () => {
  const svc = await memory()
  assert.throws(() => assess(svc, 'cdr', 'cardiovascular', { chest_pain: 'maybe' }), (e) => e.status === 400)
  assert.throws(() => assess(svc, 'cdr', 'cardiovascular', { fatigue: 3 }), (e) => e.status === 400, 'question from the other workflow')
  assert.throws(() => assess(svc, 'cdr', 'sleep_fatigue', { fatigue: 9 }), (e) => e.status === 400)
  assert.throws(() => assess(svc, 'cdr', 'sleep_fatigue', { fatigue: 2.5 }), (e) => e.status === 400)
  assert.throws(() => assess(svc, 'cdr', 'nutrition', {}), (e) => e.status === 404)
  // Common spellings of yes/no are normalised.
  const r = assess(svc, 'cdr', 'cardiovascular', { ...NO_SYMPTOMS, chest_pain: 'YES' })
  assert.equal(r.answers.chest_pain, 'yes')
  svc.close()
})

test('the self-assessment adapts to the person: self-harm only when mood is low', async () => {
  const svc = await memory()
  const ids = (crew) => questions(svc, crew, 'sleep_fatigue').questions.map((q) => q.id)
  assert.deepEqual(ids('cdr'), ['fatigue', 'dozed_on_task', 'schedule_shift'])
  assert.deepEqual(ids('ms2'), ['fatigue', 'dozed_on_task', 'schedule_shift', 'self_harm'])
  const q = questions(svc, 'cdr', 'cardiovascular').questions
  assert.equal(q[0].text, 'Do you have any chest pain, pressure or discomfort right now?')
  svc.close()
})

// --- tools and APIs ------------------------------------------------------------------------

test('tools: one definition set, validated calls, read-only', async () => {
  const svc = await memory()
  assert.deepEqual(TOOLS.map((t) => t.name), ['list_crew', 'identify_crew_member', 'get_crew_health_summary', 'get_crew_memory', 'begin_medical_check', 'get_self_assessment_questions', 'assess_cardiovascular', 'assess_sleep_fatigue', 'record_crew_memory', 'search_space_medical_knowledge', 'get_visual_observations', 'get_alertness_summary', 'assess_fatigue_concern'])
  for (const t of TOOLS) assert.equal(t.input_schema.type, 'object')
  assert.equal(callTool(svc, 'assess_cardiovascular', { crew_id: 'cdr', answers: NO_SYMPTOMS }).level, 'none')
  assert.throws(() => callTool(svc, 'delete_crew', {}), (e) => e.status === 404)
  assert.throws(() => callTool(svc, 'assess_cardiovascular', {}), (e) => e.status === 400)
  assert.throws(() => callTool(svc, 'assess_cardiovascular', { crew_id: 'cdr', threshold: 200 }), (e) => e.status === 400)
  svc.close()
})

test('HTTP routes: assessments by GET, tools by POST, nothing else writable', async () => {
  const svc = await memory()
  assert.equal(route(svc, 'GET', '/medical/crew/cdr/assessments/cardiovascular/questions').questions.length, 6)
  const r = route(svc, 'GET', '/medical/crew/cdr/assessments/cardiovascular?chest_pain=yes')
  assert.equal(r.level, 'emergency')
  assert.equal(route(svc, 'GET', '/medical/tools').tools.length, 13)
  assert.equal(route(svc, 'POST', '/medical/tools/assess_sleep_fatigue', { crew_id: 'ms2', answers: { fatigue: 5 } }).level, 'urgent')
  assert.throws(() => route(svc, 'POST', '/medical/crew/cdr'), (e) => e.status === 405)
  assert.throws(() => route(svc, 'PUT', '/medical/tools/list_crew'), (e) => e.status === 405)
  svc.close()
})

test('model adapter: every medical tool is offered with its own schema, and the policy admits it', () => {
  const offered = medicalTools(async () => memory())
  assert.deepEqual(offered.map((t) => t.name), TOOLS.map((t) => t.name))
  for (const t of TOOLS) {
    assert.deepEqual(offered.find((o) => o.name === t.name).input_schema, t.input_schema, t.name)
    assert.equal(decideTool(`mcp__mebo_medical__${t.name}`), true, t.name)
  }
})

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))

function startBridge(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MEBO_BRIDGE_PORT: '0', MEBO_MEMORY_DIR: mkdtempSync(join(tmpdir(), 'mebo-cds-mem-')), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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

function post(port, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers }, timeout: 10_000 },
      (res) => {
        let out = ''
        res.on('data', (d) => (out += d))
        res.on('end', () => resolve({ status: res.statusCode, body: out }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

test('the bridge runs assessments over HTTP, behind its origin checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mebo-cds-'))
  const bridge = await startBridge({ MEBO_MEDICAL_DB: join(dir, 'cds.sqlite') })
  try {
    const page = { origin: 'http://localhost:5173' }
    const ok = await post(bridge.port, '/medical/tools/assess_cardiovascular', { crew_id: 'cdr', answers: { chest_pain: 'yes' } }, page)
    assert.equal(ok.status, 200)
    assert.equal(JSON.parse(ok.body).level, 'emergency')
    const bad = await post(bridge.port, '/medical/tools/assess_cardiovascular', { crew_id: 'cdr' }, { origin: 'https://evil.example' })
    assert.equal(bad.status, 403)
    const invalid = await post(bridge.port, '/medical/tools/assess_cardiovascular', { crew_id: 'cdr', answers: { chest_pain: 'perhaps' } }, page)
    assert.equal(invalid.status, 400)
  } finally {
    const gone = new Promise((r) => bridge.child.once('exit', r))
    bridge.child.kill()
    await gone
    rmSync(dir, { recursive: true, force: true })
  }
})
