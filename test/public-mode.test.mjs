// Public mode (bridge/public.mjs) and the Netlify Server entry
// (netlify/server/index.mjs), through the real bridge: visitor cookies,
// private crew memory per visitor, durable memory across a restart,
// server-side limits, and the host/origin rules a hosted deploy derives.
//
// The durable store is the folder adapter (MEBO_DURABLE_MEMORY=dir:…), the
// same interface Netlify Blobs is used through; the model is the scripted
// stand-in (test-support/fake-llm.mjs). No network, no account.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { startFakeLlm } from '../test-support/fake-llm.mjs'
import { connectionLimiter, hourlyLimiter, visitorCookie, visitorIdOf } from '../bridge/public.mjs'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const NETLIFY_ENTRY = fileURLToPath(new URL('../netlify/server/index.mjs', import.meta.url))
const PAGE = 'http://localhost:5173'
const BENIGN = { fatigue: 2, dozed_on_task: 'no', schedule_shift: 'no', self_harm: 'no' }

function start(entry, env) {
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, MEBO_BRIDGE_PORT: '0', ...env },
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
const stop = async (b) => {
  const gone = new Promise((r) => b.child.once('exit', r))
  b.child.kill()
  await gone
}

/** A temp home for one bridge: database, memory, durable store. */
function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'mebo-public-'))
  return { root, db: join(root, 'db.sqlite'), memory: join(root, 'memory'), durable: join(root, 'durable') }
}

const publicEnv = (llm, d, extra = {}) => ({
  MEBO_PUBLIC: '1',
  LLM_PROVIDER: 'ollama',
  OLLAMA_URL: llm.url,
  MEBO_MEDICAL_DB: d.db,
  MEBO_MEMORY_DIR: d.memory,
  MEBO_DURABLE_MEMORY: `dir:${d.durable}`,
  ...extra,
})

const cookieOf = (setCookie) => /mebo_visitor=([a-f0-9]{32})/.exec(String(setCookie ?? ''))?.[1] ?? null

/** One HTTP request. node:http rather than fetch, because the Host header matters here. */
function http(port, path, { cookie, method = 'GET', body, origin = PAGE, host } = {}) {
  const payload = body ? JSON.stringify(body) : null
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1', port, path, method,
        headers: {
          host: host ?? `127.0.0.1:${port}`,
          ...(cookie ? { cookie: `mebo_visitor=${cookie}` } : {}),
          ...(origin ? { origin } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => {
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            /* not JSON */
          }
          const sc = res.headers['set-cookie']
          resolve({ status: res.statusCode, setCookie: Array.isArray(sc) ? sc.join('\n') : (sc ?? null), json, text })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Open a socket as a visitor; returns { ws, cookieSet } once open, or { closed: code } if refused. */
function connect(port, cookie, { origin = PAGE } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin,
      headers: cookie ? { cookie: `mebo_visitor=${cookie}` } : {},
    })
    let cookieSet = null
    ws.on('upgrade', (res) => (cookieSet = cookieOf(res.headers['set-cookie'])))
    ws.on('open', () => {
      // A refused connection is opened, then closed with 1013, at once.
      const t = setTimeout(() => resolve({ ws, cookieSet }), 150)
      ws.once('close', (code) => {
        clearTimeout(t)
        resolve({ closed: code })
      })
    })
    ws.on('unexpected-response', (_req, res) => resolve({ refused: res.statusCode }))
    ws.on('error', (err) => (err.message.includes('Unexpected server response') ? null : reject(err)))
  })
}

function ask(ws, text, id) {
  return new Promise((resolve) => {
    const events = []
    const on = (raw) => {
      const m = JSON.parse(raw.toString())
      events.push(m)
      if ((m.type === 'done' || m.type === 'error') && m.ask === id) {
        ws.off('message', on)
        resolve(events)
      }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ type: 'ask', text, id }))
  })
}

// --- unit: the small pieces ---------------------------------------------------------------

test('visitor cookie: random id, HttpOnly, SameSite=Strict, Secure; only a well-formed id is read back', () => {
  const c = visitorCookie('a'.repeat(32))
  assert.match(c, /^mebo_visitor=a{32}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/)
  assert.equal(visitorIdOf({ headers: { cookie: `x=1; mebo_visitor=${'b'.repeat(32)}` } }), 'b'.repeat(32))
  for (const bad of ['../../etc', 'B'.repeat(32), 'a'.repeat(31), 'a'.repeat(32) + '/x', '']) {
    assert.equal(visitorIdOf({ headers: { cookie: `mebo_visitor=${bad}` } }), null, bad)
  }
})

test('limiters: an hourly window per key, and connection ceilings per key and in total', () => {
  let t = 0
  const h = hourlyLimiter(2, { now: () => t })
  assert.deepEqual([h.take('a'), h.take('a'), h.take('a'), h.take('b')], [true, true, false, true])
  t += 3_600_001
  assert.equal(h.take('a'), true, 'the window slides')
  const c = connectionLimiter({ perKey: 1, total: 2 })
  assert.deepEqual([c.acquire('a'), c.acquire('a'), c.acquire('b'), c.acquire('c')], [true, false, true, false])
  c.release('a')
  assert.equal(c.acquire('c'), true)
})

// --- the bridge in public mode ----------------------------------------------------------------

test('public mode: each visitor has a private crew memory, kept durably and restored after a restart', async () => {
  const llm = await startFakeLlm()
  const d = dirs()
  let bridge = await start(SERVER, publicEnv(llm, d))
  try {
    // A new browser is given a visitor id.
    const first = await http(bridge.port, '/health')
    assert.equal(first.status, 200)
    assert.match(first.setCookie, /^mebo_visitor=[a-f0-9]{32}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/)
    assert.equal(first.json.public, true)
    assert.equal(first.json.durable_memory, 'dir')
    const a = cookieOf(first.setCookie)
    const b = cookieOf((await http(bridge.port, '/health')).setCookie)
    assert.notEqual(a, b)
    // A visitor who has one is not given another.
    assert.equal((await http(bridge.port, '/health', { cookie: a })).setCookie, null)

    // Visitor A runs an assessment through the medical API.
    const assessed = await http(bridge.port, '/medical/tools/assess_sleep_fatigue', { cookie: a, method: 'POST', body: { crew_id: 'cdr', answers: BENIGN } })
    assert.equal(assessed.status, 200)
    const id = assessed.json.trace.assessment_id

    // A sees it; B does not.
    const memA = (await http(bridge.port, '/medical/memory/cdr', { cookie: a })).json
    const memB = (await http(bridge.port, '/medical/memory/cdr', { cookie: b })).json
    assert.equal(memA.recent_assessments.at(-1).assessment_id, id)
    assert.equal(memB.recent_assessments.length, 0)
    assert.equal(memB.open_concerns.length, 0)
    assert.ok(existsSync(join(d.memory, a, 'cdr.json')))
    assert.ok(!existsSync(join(d.memory, b, 'cdr.json')))

    // A's write was copied to the durable store, under A's prefix only.
    await new Promise((r) => setTimeout(r, 200))
    const durable = JSON.parse(readFileSync(join(d.durable, a, 'cdr.json'), 'utf8'))
    assert.equal(durable.assessments.at(-1).assessment_id, id)
    assert.ok(!existsSync(join(d.durable, b)))

    // A fresh instance (empty local memory) restores A's memory from the durable store.
    await stop(bridge)
    bridge = await start(SERVER, publicEnv(llm, { ...d, memory: join(d.root, 'memory-after-restart') }))
    const restored = (await http(bridge.port, '/medical/memory/cdr', { cookie: a })).json
    assert.equal(restored.recent_assessments.at(-1).assessment_id, id, 'memory survived the restart')
    assert.equal((await http(bridge.port, '/medical/memory/cdr', { cookie: b })).json.recent_assessments.length, 0)
  } finally {
    await stop(bridge)
    await llm.close()
    rmSync(d.root, { recursive: true, force: true })
  }
})

test('public mode: conversations use the visitor\'s own memory; model calls, connections and question length are limited', async () => {
  const llm = await startFakeLlm()
  const d = dirs()
  // One assessment by voice takes three model calls (list_crew, assess, answer).
  const bridge = await start(SERVER, publicEnv(llm, d, { MEBO_VISITOR_CALLS_PER_HOUR: '3', MEBO_VISITOR_CONNECTIONS: '1', MEBO_MAX_QUESTION_CHARS: '200' }))
  try {
    // The handshake gives a cookie-less browser its visitor id.
    const opened = await connect(bridge.port, null)
    assert.ok(opened.ws, 'connected')
    const visitor = opened.cookieSet
    assert.match(visitor, /^[a-f0-9]{32}$/)

    const events = await ask(opened.ws, "MeBo, please assess Novak's heart. No symptoms.", 'q1')
    assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events.filter((e) => e.type === 'error')))
    assert.ok(existsSync(join(d.memory, visitor, 'ms2.json')), 'filed in this visitor\'s memory')
    assert.ok(!existsSync(join(d.memory, 'ms2.json')), 'not in a shared memory')

    // The visitor's hourly budget of model calls is spent: the next question is refused, and said so.
    const refused = await ask(opened.ws, "MeBo, please assess Novak's heart. No symptoms.", 'q2')
    const err = refused.find((e) => e.type === 'error')
    assert.ok(err, 'refused')
    assert.match(err.message, /as many questions as I may for now/)

    // Too long a question never reaches the model.
    const long = await ask(opened.ws, 'x'.repeat(201), 'q3')
    assert.match(long.find((e) => e.type === 'error').message, /too long/)

    // One conversation per visitor here: a second socket with the same cookie is closed.
    const second = await connect(bridge.port, visitor)
    assert.equal(second.closed, 1013)
    // Another visitor still gets in.
    const other = await connect(bridge.port, null)
    assert.ok(other.ws)
    other.ws.close()
    opened.ws.close()

    // The page-fetching proxies of the original assistant are off in public mode.
    for (const path of ['/img?url=https://example.com/a.png', '/page?url=https://example.com', '/file?path=/tmp/a.png', '/media?url=https://example.com/a.mp3']) {
      assert.equal((await http(bridge.port, path, { cookie: visitor })).status, 404, path)
    }
    for (let i = 0; i < 30 && !/PUBLIC mode/.test(bridge.log()); i++) await new Promise((r) => setTimeout(r, 100))
    assert.match(bridge.log(), /PUBLIC mode: private memory per visitor \(durable: dir\)/)
  } finally {
    await stop(bridge)
    await llm.close()
    rmSync(d.root, { recursive: true, force: true })
  }
})

test('public mode: medical API writes are limited per visitor', async () => {
  const llm = await startFakeLlm()
  const d = dirs()
  const bridge = await start(SERVER, publicEnv(llm, d, { MEBO_VISITOR_WRITES_PER_HOUR: '2' }))
  try {
    const a = cookieOf((await http(bridge.port, '/health')).setCookie)
    const post = () => http(bridge.port, '/medical/tools/list_crew', { cookie: a, method: 'POST', body: {} })
    assert.deepEqual([(await post()).status, (await post()).status, (await post()).status], [200, 200, 429])
    const other = cookieOf((await http(bridge.port, '/health')).setCookie)
    assert.equal((await http(bridge.port, '/medical/tools/list_crew', { cookie: other, method: 'POST', body: {} })).status, 200, 'another visitor is unaffected')
  } finally {
    await stop(bridge)
    await llm.close()
    rmSync(d.root, { recursive: true, force: true })
  }
})

test('local mode is unchanged: no cookie, one shared memory', async () => {
  const llm = await startFakeLlm()
  const d = dirs()
  const bridge = await start(SERVER, { LLM_PROVIDER: 'ollama', OLLAMA_URL: llm.url, MEBO_MEDICAL_DB: d.db, MEBO_MEMORY_DIR: d.memory })
  try {
    const h = await http(bridge.port, '/health')
    assert.equal(h.setCookie, null)
    assert.equal(h.json.public, false)
    await http(bridge.port, '/medical/tools/assess_sleep_fatigue', { method: 'POST', body: { crew_id: 'cdr', answers: BENIGN } })
    assert.ok(existsSync(join(d.memory, 'cdr.json')))
  } finally {
    await stop(bridge)
    await llm.close()
    rmSync(d.root, { recursive: true, force: true })
  }
})

// --- the Netlify Server entry ----------------------------------------------------------------

test('Netlify entry: public mode on, the site\'s own host and origin allowed, anything else refused', async () => {
  const llm = await startFakeLlm()
  const d = dirs()
  // PORT as Netlify sets it; URL and DEPLOY_PRIME_URL as Netlify provides them.
  // The durable store is the folder adapter here (Blobs needs Netlify's runtime).
  const bridge = await start(NETLIFY_ENTRY, {
    PORT: '0', MEBO_BRIDGE_PORT: '', URL: 'https://mebo-demo.netlify.app', DEPLOY_PRIME_URL: 'https://preview--mebo-demo.netlify.app',
    LLM_PROVIDER: 'ollama', OLLAMA_URL: llm.url,
    MEBO_MEDICAL_DB: d.db, MEBO_MEMORY_DIR: d.memory, MEBO_DURABLE_MEMORY: `dir:${d.durable}`,
    MEBO_ALLOWED_HOSTS: '', MEBO_ALLOWED_ORIGINS: '',
  })
  try {
    for (let i = 0; i < 30 && !/PUBLIC mode/.test(bridge.log()); i++) await new Promise((r) => setTimeout(r, 100))
    assert.match(bridge.log(), /PUBLIC mode/)
    assert.match(bridge.log(), /listening on ws:\/\/0\.0\.0\.0/)
    const site = 'https://mebo-demo.netlify.app'
    const ok = await http(bridge.port, '/health', { host: 'mebo-demo.netlify.app', origin: site })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.public, true)
    assert.equal((await http(bridge.port, '/health', { host: 'preview--mebo-demo.netlify.app', origin: 'https://preview--mebo-demo.netlify.app' })).status, 200)
    assert.equal((await http(bridge.port, '/health', { host: 'evil.example' })).status, 403, 'foreign Host')
    assert.equal((await http(bridge.port, '/health', { host: 'mebo-demo.netlify.app', origin: 'https://evil.example' })).status, 403, 'foreign Origin')

    // The knowledge library ships with the server and is found through MEBO_KNOWLEDGE_CORPUS.
    const k = await http(bridge.port, '/medical/knowledge/search?q=radiation', { host: 'mebo-demo.netlify.app', origin: site })
    assert.equal(k.status, 200)
    assert.equal(k.json.found, true)
  } finally {
    await stop(bridge)
    await llm.close()
    rmSync(d.root, { recursive: true, force: true })
  }
})
