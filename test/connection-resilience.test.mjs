// Connections that survive a hosted deploy: the bridge's heartbeat, its
// shutdown (close code 1012), the page's reconnect and speech-recognition
// backoff, and the list of sound files the page may request.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect as tcp } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { reconnectDelay, restartDelay } from '../src/lib/backoff.ts'
import { startFakeLlm } from '../test-support/fake-llm.mjs'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const PAGE = 'http://localhost:5173'

/** Start the bridge in a child that can be sent a real shutdown signal on any OS. */
function start(env) {
  // process.emit('SIGTERM') runs the bridge's own shutdown handler, which a
  // child.kill() on Windows would not.
  const boot = `await import(${JSON.stringify(pathToFileURL(SERVER).href)}); process.stdin.on('data', () => process.emit('SIGTERM'))`
  const child = spawn(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, MEBO_BRIDGE_PORT: '0', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
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
  })
}
const stop = async (b) => {
  if (b.child.exitCode !== null) return
  const gone = new Promise((r) => b.child.once('exit', r))
  b.child.kill()
  await gone
}

/** A WebSocket handshake by hand, after which this "client" never answers a ping (a dead laptop). */
function deadClient(port, cookie) {
  return new Promise((resolve, reject) => {
    const sock = tcp(port, '127.0.0.1')
    let head = ''
    sock.on('connect', () =>
      sock.write(
        [
          'GET /ws HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
          'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', `Origin: ${PAGE}`,
          ...(cookie ? [`Cookie: mebo_visitor=${cookie}`] : []), '', '',
        ].join('\r\n'),
      ),
    )
    sock.on('data', (d) => {
      head += d.toString('latin1')
      if (head.includes('\r\n\r\n') && !sock.upgraded) {
        sock.upgraded = true
        if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(head.split('\r\n')[0]))
        resolve(sock)
      }
    })
    sock.on('error', () => {})
  })
}

test('reconnect and recognition backoff: immediate on restart, capped, never giving up', () => {
  assert.equal(reconnectDelay(0, 1012), 0, 'a restart reconnects at once')
  assert.equal(reconnectDelay(3, 1012), 1000)
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((a) => reconnectDelay(a)), [500, 1000, 2000, 4000, 8000, 15000, 30000])
  assert.equal(reconnectDelay(50), 30000, 'capped, and still retrying after many attempts')
  assert.equal(reconnectDelay(0, 1013), 5000, 'busy waits longer')
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(restartDelay), [80, 160, 320, 640, 1280, 2560, 5000, 5000])
})

test('heartbeat: a socket that stops answering pings is ended; a live one stays', async () => {
  const llm = await startFakeLlm()
  const bridge = await start({ LLM_PROVIDER: 'ollama', OLLAMA_URL: llm.url, MEBO_HEARTBEAT_MS: '150' })
  try {
    const live = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { origin: PAGE })
    await new Promise((r) => live.on('open', r))
    const dead = await deadClient(bridge.port)
    const ended = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 3000)
      dead.on('close', () => (clearTimeout(t), resolve(true)))
    })
    assert.ok(ended, 'the unresponsive socket was terminated')
    assert.equal(live.readyState, WebSocket.OPEN, 'the responsive socket is still open')
    live.close()
  } finally {
    await stop(bridge)
    await llm.close()
  }
})

test('shutdown: every open conversation is closed with 1012 so the page reconnects at once', async () => {
  const llm = await startFakeLlm()
  const bridge = await start({ LLM_PROVIDER: 'ollama', OLLAMA_URL: llm.url })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { origin: PAGE })
    await new Promise((r) => ws.on('open', r))
    const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })))
    bridge.child.stdin.write('go\n') // → SIGTERM in the bridge
    const { code, reason } = await closed
    assert.equal(code, 1012)
    assert.match(reason, /restarting/)
    await new Promise((r) => bridge.child.once('exit', r))
  } finally {
    await stop(bridge)
    await llm.close()
  }
})

test('public mode: a returning visitor is let back in once their dead socket is cleared', async () => {
  const llm = await startFakeLlm()
  const root = mkdtempSync(join(tmpdir(), 'mebo-resilience-'))
  const bridge = await start({
    LLM_PROVIDER: 'ollama', OLLAMA_URL: llm.url, MEBO_PUBLIC: '1', MEBO_VISITOR_CONNECTIONS: '1', MEBO_HEARTBEAT_MS: '150',
    MEBO_MEDICAL_DB: join(root, 'db.sqlite'), MEBO_MEMORY_DIR: join(root, 'memory'),
  })
  try {
    const visitor = 'c'.repeat(32)
    const dead = await deadClient(bridge.port, visitor) // holds the visitor's one connection, then goes silent
    await new Promise((resolve) => dead.on('close', resolve)) // ended by the heartbeat
    const again = new WebSocket(`ws://127.0.0.1:${bridge.port}/ws`, { origin: PAGE, headers: { cookie: `mebo_visitor=${visitor}` } })
    const outcome = await new Promise((resolve) => {
      again.on('close', (code) => resolve(`closed ${code}`))
      again.on('open', () => setTimeout(() => resolve(again.readyState === WebSocket.OPEN ? 'open' : 'closed'), 300))
    })
    assert.equal(outcome, 'open', 'not refused for a connection that no longer exists')
    again.close()
  } finally {
    await stop(bridge)
    await llm.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the page requests only sound files that ship: the build lists public/audio/*.mp3', async () => {
  const { default: config } = await import('../vite.config.ts')
  const shipped = JSON.parse(config.define.__MEBO_AUDIO_FILES__)
  assert.ok(shipped.includes('work'), 'the music cue that ships')
  for (const cue of ['boot', 'wake', 'listen', 'tool', 'done', 'error', 'ambient']) {
    assert.ok(!shipped.includes(cue), `${cue}.mp3 does not ship, so it must not be requested`)
  }
})
