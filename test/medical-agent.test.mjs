// "Assess Novak" end to end through the real bridge, on both model providers
// (Step 28): browser socket → agent loop → provider adapter → tool call →
// medical service → SQLite → assessment → spoken text back to the browser.
//
// The model is replaced by test-support/fake-llm.mjs, a scripted stand-in
// that speaks both Hugging Face's OpenAI-compatible protocol and Ollama's
// native one. Everything else is production code. No network, no account.
//
//   node --test test/

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { createMedicalService } from '../medical/service.mjs'
import { startFakeLlm } from '../test-support/fake-llm.mjs'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const PAGE = 'http://localhost:5173'

const ALL_TOOLS = ['list_crew', 'identify_crew_member', 'get_crew_health_summary', 'get_crew_memory', 'begin_medical_check', 'get_self_assessment_questions', 'assess_cardiovascular', 'assess_sleep_fatigue', 'record_crew_memory', 'search_space_medical_knowledge', 'get_visual_observations', 'get_alertness_summary', 'assess_fatigue_concern', 'request_visual_observation']

/** The two providers, each pointed at the fake model. */
const PROVIDERS = {
  huggingface: (llm) => ({ LLM_PROVIDER: 'huggingface', HF_TOKEN: 'test-token', HF_BASE_URL: `${llm.url}/v1`, HF_MODEL: 'google/gemma-4-26B-A4B-it' }),
  ollama: (llm) => ({ LLM_PROVIDER: 'ollama', OLLAMA_URL: llm.url, OLLAMA_MODEL: 'gemma4:e4b' }),
}

function startBridge(env) {
  const child = spawn(process.execPath, [SERVER], {
    // A private memory directory per bridge: never the real memory/crew/.
    env: { ...process.env, MEBO_BRIDGE_PORT: '0', MEBO_MEMORY_DIR: mkdtempSync(join(tmpdir(), 'mebo-agent-mem-')), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (child.kill(), reject(new Error(`bridge did not start: ${log}`))), 20_000)
    child.stdout.on('data', (d) => {
      log += d
      const m = /bridge listening on ws:\/\/(\S+):(\d+)/.exec(log)
      if (m) {
        clearTimeout(timer)
        resolve({ child, port: Number(m[2]), log: () => log })
      }
    })
    child.stderr.on('data', (d) => (log += d))
    child.on('exit', (code) => reject(new Error(`bridge exited ${code}: ${log}`)))
  })
}

async function stopBridge(bridge) {
  const gone = new Promise((r) => bridge.child.once('exit', r))
  bridge.child.kill()
  await gone
}

/**
 * Ask one question as the browser does; collect everything until `done`.
 * `page`, if given, plays the rest of the browser: it sees every frame and
 * can answer the bridge's requests (a camera check) on the same socket.
 */
function ask(port, text, id = 'turn-1', page = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: PAGE })
    const events = []
    const timer = setTimeout(() => (ws.close(), reject(new Error(`no answer; got ${JSON.stringify(events)}`))), 30_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'ask', text, id })))
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      events.push(msg)
      if (page) void page(msg, (reply) => ws.send(JSON.stringify({ type: 'reply', id: msg.id, ...reply })))
      if ((msg.type === 'done' || msg.type === 'error') && msg.ask === id) {
        clearTimeout(timer)
        ws.close()
        resolve(events)
      }
    })
    ws.on('error', reject)
  })
}

/** A bridge on `provider`, talking to a fresh fake model; cleaned up afterwards. */
async function withBridge(provider, env, fn) {
  const llm = await startFakeLlm()
  const dir = mkdtempSync(join(tmpdir(), 'mebo-agent-'))
  const bridge = await startBridge({ MEBO_MEDICAL_DB: join(dir, 'agent.sqlite'), ...PROVIDERS[provider](llm), ...env })
  try {
    await fn({ bridge, llm, dir })
  } finally {
    await stopBridge(bridge)
    await llm.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const ASK = "MeBo, please assess Novak's heart. No symptoms."
const spokenOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('')

for (const provider of Object.keys(PROVIDERS)) {
  test(`[${provider}] assessing Novak reaches the cardiovascular tool and Novak's simulated records`, async () => {
    await withBridge(provider, {}, async ({ bridge, llm, dir }) => {
      const events = await ask(bridge.port, ASK)

      // 1. Registration: the provider was sent every medical tool, with the
      //    medical tools' own schemas, and the prompt that says to use them.
      const first = llm.requests[0]
      assert.equal(first.protocol, provider === 'huggingface' ? 'openai' : 'ollama')
      assert.equal(first.model, provider === 'huggingface' ? 'google/gemma-4-26B-A4B-it' : 'gemma4:e4b')
      assert.deepEqual(first.tools, ALL_TOOLS)
      const assessDef = first.raw.tools.find((t) => t.function.name === 'assess_cardiovascular').function
      assert.deepEqual(assessDef.parameters.required, ['crew_id'])
      assert.equal(assessDef.parameters.additionalProperties, false)
      assert.match(first.system, /Crew health — the mebo_medical tools/)
      assert.match(first.system, /assess_cardiovascular/)
      // Only the medical tools exist on these providers; the prompt does not describe others.
      assert.doesNotMatch(first.system, /chrome_|blade/)

      // 2. A complete tool cycle: list_crew, then the assessment, each result fed back.
      assert.deepEqual(llm.toolResults.map((r) => r.name), ['list_crew', 'assess_cardiovascular'])
      const call = llm.toolResults.find((e) => e.name === 'assess_cardiovascular')
      assert.equal(call.isError, false)
      assert.equal(call.input.crew_id, 'ms2')
      const result = JSON.parse(call.text)
      assert.equal(result.crew.callsign, 'NOVAK')
      assert.equal(result.workflow, 'cardiovascular')
      assert.equal(result.simulated, true)
      assert.match(result.notice, /SYNTHETIC/)
      assert.equal(result.status, 'complete')

      const svc = await createMedicalService({ path: join(dir, 'agent.sqlite') })
      try {
        const latest = svc.summary('ms2').metrics
        for (const metric of ['heart_rate', 'bp_systolic', 'bp_diastolic']) {
          const obs = result.observations[metric]
          assert.equal(obs.value, latest[metric].latest.value, `${metric} value is Novak's latest reading`)
          assert.equal(obs.observation_id, latest[metric].latest.observation_id, `${metric} row id`)
          assert.equal(obs.is_simulated, true)
        }
        assert.equal(result.trace.dataset_sha256, svc.provenance().dataset_sha256)
      } finally {
        svc.close()
      }

      // 3. Back to the browser: the tool appears on the HUD under the same name as
      //    before, and the spoken text is the assessment's own summary and guidance.
      assert.ok(events.some((e) => e.type === 'tool' && e.name === 'mcp__mebo_medical__assess_cardiovascular'), 'tool announced to the interface')
      const spoken = spokenOf(events)
      assert.ok(spoken.includes('NOVAK'), spoken)
      assert.ok(spoken.includes(result.summary), spoken)
      assert.ok(spoken.includes(result.escalation.guidance), spoken)
      assert.equal(events.find((e) => e.type === 'done').text, spoken)

      // The Medical Agents panel is told what ran and how it came out.
      const medical = events.filter((e) => e.type === 'medical').map((e) => e.activity)
      const ended = medical.find((a) => a.tool === 'assess_cardiovascular' && a.phase === 'end')
      assert.ok(medical.find((a) => a.tool === 'assess_cardiovascular' && a.phase === 'start') && ended)
      assert.equal(ended.crew_id, 'ms2')
      assert.equal(ended.callsign, 'NOVAK')
      assert.equal(ended.level, result.level)
      assert.equal(ended.assessment_id, result.trace.assessment_id)
      assert.equal(result.memory.recorded, result.trace.assessment_id)

      // 4. /health says which model answers, never the credential.
      const health = await (await fetch(`http://127.0.0.1:${bridge.port}/health`)).json()
      assert.equal(health.code_changed, false)
      assert.deepEqual(health.medical_tools, ALL_TOOLS)
      assert.deepEqual(health.llm, { provider, model: first.model })
      assert.doesNotMatch(JSON.stringify(health), /test-token/)
      assert.doesNotMatch(bridge.log(), /test-token/)
      assert.match(bridge.log(), /\[mebo\] medical tools \(mebo_medical\): list_crew/)
    })
  })

  test(`[${provider}] an explanation question reaches the NASA knowledge tool and speaks its cited passage`, async () => {
    await withBridge(provider, {}, async ({ bridge, llm }) => {
      const events = await ask(bridge.port, 'Explain how microgravity affects the heart.', 'turn-k')
      assert.match(llm.requests[0].system, /search_space_medical_knowledge/)
      const call = llm.toolResults.find((e) => e.name === 'search_space_medical_knowledge')
      const found = JSON.parse(call.text)
      assert.equal(found.found, true)
      assert.equal(found.results[0].passage_id, 'S2:risk-of-cardiovascular-adaptations')
      const spoken = spokenOf(events)
      assert.match(spoken, /Weightlessness alters blood circulation/)
      assert.match(spoken, /NASA Human Research Program, "Risks of Human Spaceflight"/)
      assert.ok(events.some((e) => e.type === 'tool' && e.name === 'mcp__mebo_medical__search_space_medical_knowledge'))
    })
  })
}

/** A camera check's summary, as the page's observe.ts produces it. */
const OBSERVATION = {
  protocol: 'face_basic_v1', duration_s: 34.2, frames: 500, fps: 14.6, face_visible_ratio: 0.97,
  tasks: [
    { id: 'face_camera', completed: true, seconds: 2.1 },
    { id: 'eyes_closed', completed: true, seconds: 4.3 },
    { id: 'head_turn', completed: true, seconds: 3.9 },
    { id: 'hold_still', completed: true, seconds: 5.1 },
  ],
  indicators: {
    blinks: 6, longest_unprompted_eye_closure_s: 0.3, prolonged_unprompted_eye_closures: 0,
    head_yaw_range_deg: 52.4, head_pitch_range_deg: 8.1, hold_still_movement: 0.08, hold_still_steady: true,
  },
}

test('a camera check runs in the page and comes back as an observation, not a diagnosis', async () => {
  const memDir = mkdtempSync(join(tmpdir(), 'mebo-agent-mem-'))
  await withBridge('ollama', { MEBO_MEMORY_DIR: memDir }, async ({ bridge, llm }) => {
    const requests = []
    // The page: run the "check" (here, a fixed summary), file it with the
    // bridge over HTTP exactly as src/lib/visual/assessment.ts does, reply.
    const events = await ask(bridge.port, 'MeBo, please do a camera check for Novak.', 'turn-v', async (msg, reply) => {
      if (msg.type !== 'visual') return
      requests.push(msg)
      const res = await fetch(`http://127.0.0.1:${bridge.port}/medical/visual-observations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PAGE },
        body: JSON.stringify({ crew_id: msg.crew_id, observation: OBSERVATION }),
      })
      const { recorded } = await res.json()
      // Then the sleep and fatigue follow-up the console runs (Step 26C),
      // through the same local tools.
      const assess = await fetch(`http://127.0.0.1:${bridge.port}/medical/tools/assess_sleep_fatigue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PAGE },
        body: JSON.stringify({ crew_id: msg.crew_id, answers: { fatigue: 2, dozed_on_task: 'no', schedule_shift: 'no', self_harm: 'no' } }),
      }).then((r) => r.json())
      const sleep_fatigue = {
        declined: false, completed: true, level: assess.level, status: assess.status, summary: assess.summary,
        guidance: assess.escalation.guidance, incomplete_note: null, missing: [], assessment_id: assess.trace.assessment_id, camera_note: null,
      }
      reply({ recorded, observation: OBSERVATION, saved: res.ok, description: recorded.description, sleep_fatigue })
    })
    assert.match(llm.requests[0].system, /request_visual_observation/)
    assert.match(llm.requests[0].system, /never let it change a\s+result/)
    assert.match(llm.requests[0].system, /do not ask them\s+again/)

    // The bridge asked the page — the model supplied only who it was for.
    assert.equal(requests.length, 1)
    assert.deepEqual(Object.keys(requests[0]).sort(), ['crew_id', 'id', 'type'])
    assert.equal(requests[0].crew_id, 'ms2')

    const call = llm.toolResults.find((e) => e.name === 'request_visual_observation')
    assert.equal(call.isError, false)
    const result = JSON.parse(call.text)
    assert.equal(result.affects_assessment, false)
    assert.match(result.observation_id, /^vis-/)
    assert.equal(result.saved, true)
    assert.ok(!('level' in result) && !('escalation' in result), 'no level or escalation in an observation')

    const spoken = spokenOf(events)
    assert.match(spoken, /^NOVAK: Face in view 97%/)
    assert.equal(result.sleep_fatigue.completed, true)
    assert.ok(spoken.includes(result.sleep_fatigue.guidance), 'the rules engine\'s guidance is spoken as given')
    const novak = JSON.parse(readFileSync(join(memDir, 'ms2.json'), 'utf8'))
    assert.equal(novak.observations[0].observation_id, result.observation_id)
    assert.ok(
      novak.concerns.every((c) => c.opened_by === result.sleep_fatigue.assessment_id),
      `concerns opened only by the assessment: ${novak.concerns.map((c) => c.opened_by).join(', ')}`,
    )
    assert.ok(!existsSync(join(memDir, 'ms1.json')))
    assert.ok(events.some((e) => e.type === 'medical' && e.activity.tool === 'request_visual_observation' && e.activity.phase === 'end' && e.activity.ok))
  })
  rmSync(memDir, { recursive: true, force: true })
})

test('a refused camera is reported as refused, and nothing is filed', async () => {
  const memDir = mkdtempSync(join(tmpdir(), 'mebo-agent-mem-'))
  await withBridge('huggingface', { MEBO_MEMORY_DIR: memDir }, async ({ bridge, llm }) => {
    const events = await ask(bridge.port, 'MeBo, please do a camera check for Novak.', 'turn-d', async (msg, reply) => {
      if (msg.type === 'visual') reply({ error: 'I cannot use the camera, because permission was not given.' })
    })
    const call = llm.toolResults.find((e) => e.name === 'request_visual_observation')
    assert.equal(call.isError, true)
    assert.match(call.text, /permission was not given/)
    assert.match(spokenOf(events), /permission was not given/)
    assert.ok(!existsSync(join(memDir, 'ms2.json')), 'no observation was filed')
  })
  rmSync(memDir, { recursive: true, force: true })
})

test('with the camera disabled, the camera check is not offered', async () => {
  await withBridge('ollama', { MEBO_DISABLE: 'camera' }, async ({ bridge, llm }) => {
    await ask(bridge.port, ASK)
    assert.ok(!llm.requests[0].tools.includes('request_visual_observation'))
    assert.doesNotMatch(llm.requests[0].system, /request_visual_observation/)
    const health = await (await fetch(`http://127.0.0.1:${bridge.port}/health`)).json()
    assert.ok(!health.medical_tools.includes('request_visual_observation'))
    assert.ok(health.medical_tools.includes('get_visual_observations'), 'earlier observations stay readable')
  })
})

test('without the medical tools, the model has nothing to call and says so', async () => {
  await withBridge('ollama', { MEBO_DISABLE: 'medical' }, async ({ bridge, llm }) => {
    const events = await ask(bridge.port, ASK)
    assert.deepEqual(llm.requests[0].tools, [])
    assert.doesNotMatch(llm.requests[0].system, /mebo_medical/)
    assert.equal(spokenOf(events), "I do not have Novak's cardiovascular records on this console.")
    assert.ok(!events.some((e) => e.type === 'tool'))
    const health = await (await fetch(`http://127.0.0.1:${bridge.port}/health`)).json()
    assert.deepEqual(health.medical_tools, [])
  })
})

test('a provider failure ends the turn with a spoken error, not silence; a bad token never leaks', async () => {
  const llm = await startFakeLlm({ token: 'the-right-token' })
  const dir = mkdtempSync(join(tmpdir(), 'mebo-agent-'))
  const bridge = await startBridge({ MEBO_MEDICAL_DB: join(dir, 'agent.sqlite'), ...PROVIDERS.huggingface(llm), HF_TOKEN: 'hf_wrong_secret' })
  try {
    const events = await ask(bridge.port, ASK, 'turn-e')
    const err = events.find((e) => e.type === 'error')
    assert.ok(err, 'an error reached the browser')
    assert.equal(err.message, 'The turn failed part way through.')
    assert.doesNotMatch(JSON.stringify(events), /hf_wrong_secret/)
    assert.doesNotMatch(bridge.log(), /hf_wrong_secret/)
    assert.match(bridge.log(), /huggingface turn failed: HTTP 401/)
  } finally {
    await stopBridge(bridge)
    await llm.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the conversation carries over: a second question in the same session sees the first', async () => {
  const llm = await startFakeLlm()
  const dir = mkdtempSync(join(tmpdir(), 'mebo-agent-'))
  const bridge = await startBridge({ MEBO_MEDICAL_DB: join(dir, 'agent.sqlite'), ...PROVIDERS.ollama(llm) })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { origin: PAGE })
    await new Promise((r) => ws.on('open', r))
    const done = (id) => new Promise((resolve) => ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'done' && m.ask === id) resolve(m)
    }))
    ws.send(JSON.stringify({ type: 'ask', text: ASK, id: 'a' }))
    await done('a')
    ws.send(JSON.stringify({ type: 'ask', text: 'Explain how microgravity affects the heart.', id: 'b' }))
    await done('b')
    ws.close()
    const last = llm.requests.at(-1).messages
    assert.equal(last.filter((m) => m.role === 'user').length, 2, 'both questions are in the history')
    assert.ok(last.some((m) => m.role === 'tool' && (m.tool_name ?? m.name) === 'assess_cardiovascular'), 'the first turn\'s tool result is kept')
  } finally {
    await stopBridge(bridge)
    await llm.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
