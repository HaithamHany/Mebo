/**
 * MeBo's voice: Piper `en_US-lessac-medium`, synthesised entirely in the
 * browser.
 *
 * Piper is a small VITS model (~63 MB) built for fast local speech. The
 * Lessac voice is a clear, even American female voice, which suits a calm
 * medical companion better than the British butler voices this project
 * started with. Generation runs in a Web Worker (piper.worker.ts) so the
 * microphone loop never stalls behind it, and nothing leaves the machine —
 * the model is served from this origin, fetched once by
 * `npm run piper:download`.
 *
 * Same contract as kokoro.ts: speak() resolves to a blob URL for tts.ts to
 * play through its analysed <audio> path (which is what drives the core's
 * lip-sync), or null if Piper can't help — and tts.ts then falls back to
 * Kokoro, then to the system voice.
 */
import { PIPER_RATE } from '../config'
import type { WorkerIn, WorkerOut } from './piper.worker'

export const VOICE = 'en_US-lessac-medium'
const MODEL_URL = `/models/piper/${VOICE}.onnx`
const CONFIG_URL = `/models/piper/${VOICE}.onnx.json`

// ---------------------------------------------------------------------------
// Speech rate
// ---------------------------------------------------------------------------

/** 1 is the voice's natural pace; below 1 is slower and calmer. */
export const RATE_MIN = 0.5
export const RATE_MAX = 1.5
const RATE_KEY = 'mebo.piper.rate'

const clampRate = (r: number) => Math.min(RATE_MAX, Math.max(RATE_MIN, r))

function storedRate(): number | null {
  try {
    const v = Number(localStorage.getItem(RATE_KEY))
    return Number.isFinite(v) && v > 0 ? clampRate(v) : null
  } catch {
    return null
  }
}

let rate = storedRate() ?? clampRate(PIPER_RATE)

export const getRate = () => rate

/**
 * Change the speaking rate from the next sentence on. Remembered in this
 * browser, so a value tuned by ear survives a reload; `resetRate()` goes back
 * to VITE_PIPER_RATE.
 */
export function setRate(r: number): number {
  if (!Number.isFinite(r)) return rate
  rate = clampRate(r)
  try {
    localStorage.setItem(RATE_KEY, String(rate))
  } catch {
    /* private mode — the value still holds for this page */
  }
  return rate
}

export function resetRate(): number {
  try {
    localStorage.removeItem(RATE_KEY)
  } catch {
    /* ignore */
  }
  rate = clampRate(PIPER_RATE)
  return rate
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let loading: Promise<boolean> | null = null
let ready = false
let failed = false
let progress = 0

export const loadProgress = () => progress
export const isReady = () => ready
export const isUnavailable = () => failed

/** Exposed for diagnosis, like kokoro.lastError. */
export let lastError = ''
/** Timing of the last sentence, for tuning: generation ms and audio seconds. */
export const stats = { lastMs: 0, lastSeconds: 0, sentences: 0 }

const pending = new Map<number, (url: string | null) => void>()
let nextId = 1

/** Generous: the first sentence after load also pays for WASM warm-up. */
const SYNTH_TIMEOUT_MS = 20000
/**
 * Plus this much per character. Generation time grows with the text, and a
 * fixed limit abandoned long passages that were still on their way — the
 * speaker then fell back to another voice mid-conversation (measured: a
 * 900-character announcement took 23 s headless).
 */
const SYNTH_MS_PER_CHAR = 40
/** Same latch as Kokoro: a run of failures means this engine is done for the page. */
const MAX_FAILURES = 3
let failures = 0

function fail(why: string) {
  lastError = why
  failed = true
  ready = false
  for (const resolve of pending.values()) resolve(null)
  pending.clear()
  worker?.terminate()
  worker = null
}

export function load(): Promise<boolean> {
  if (ready) return Promise.resolve(true)
  if (failed) return Promise.resolve(false)
  if (loading) return loading

  loading = new Promise<boolean>((resolve) => {
    try {
      worker = new Worker(new URL('./piper.worker.ts', import.meta.url), {
        type: 'module',
      })
    } catch (err) {
      console.warn('[mebo] piper worker could not start:', err)
      fail(String((err as Error)?.message ?? err))
      resolve(false)
      return
    }

    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      switch (m.type) {
        case 'progress':
          progress = m.value
          break
        case 'ready':
          progress = 1
          ready = true
          resolve(true)
          break
        case 'error':
          console.warn('[mebo] piper unavailable, falling back:', m.error)
          fail(m.error)
          resolve(false)
          break
        case 'audio': {
          stats.lastMs = Math.round(m.ms)
          stats.lastSeconds = Number(m.seconds.toFixed(2))
          stats.sentences++
          failures = 0
          const key = keys.get(m.id)
          keys.delete(m.id)
          if (key) remember(key, m.wav)
          const url = URL.createObjectURL(new Blob([m.wav], { type: 'audio/wav' }))
          pending.get(m.id)?.(url)
          pending.delete(m.id)
          break
        }
        case 'fail':
          console.error('[mebo] piper generation failed:', m.error)
          lastError = m.error
          keys.delete(m.id)
          pending.get(m.id)?.(null)
          pending.delete(m.id)
          if (++failures >= MAX_FAILURES) {
            console.warn(`[mebo] piper failed ${failures} times running — falling back for good.`)
            fail(m.error)
          }
          break
      }
    }
    worker.onerror = (e) => {
      console.warn('[mebo] piper worker crashed:', e.message)
      fail(e.message || 'worker error')
      resolve(false)
    }

    worker.postMessage({ type: 'init', model: MODEL_URL, config: CONFIG_URL } satisfies WorkerIn)
  }).finally(() => {
    loading = null
  })

  return loading
}

// ---------------------------------------------------------------------------
// Short lines, generated once
// ---------------------------------------------------------------------------

/**
 * Audio for short lines, by rate and text.
 *
 * MeBo's most time-critical speech is also its most repetitive: the answer to
 * its name, the introduction, the "Checking your records." filler. Through
 * Piper each took half a second or more to generate — measured 0.5 s from
 * "Hey MeBo" to the first sound of "Hello.", against the next frame for the
 * system voice MeBo used — and the first sentence after loading paid about
 * a second more for the runtime's warm-up. Kept here, a repeat plays at once.
 * Only short lines are kept, so model answers never fill it.
 */
const CACHE_MAX_CHARS = 80
const CACHE_MAX = 48
const cache = new Map<string, ArrayBuffer>()
/** Request id → cache key, for requests whose audio should be kept. */
const keys = new Map<number, string>()

const keyOf = (text: string) => `${rate}|${text.trim()}`

function remember(key: string, wav: ArrayBuffer) {
  cache.delete(key)
  // A copy: the original is handed to a Blob and may be read from there.
  cache.set(key, wav.slice(0))
  // Oldest out first; a Map iterates in insertion order.
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
}

function fromCache(key: string): string | null {
  const wav = cache.get(key)
  if (!wav) return null
  cache.delete(key)
  cache.set(key, wav) // most recently used
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
}

/** Synthesise one sentence. Resolves to a blob URL, or null if Piper can't. */
export async function speak(text: string): Promise<string | null> {
  const key = text.trim().length <= CACHE_MAX_CHARS ? keyOf(text) : null
  const hit = key && fromCache(key)
  if (hit) return hit
  if (!(await load()) || !worker) return null
  return request(text, key)
}

function request(text: string, key: string | null): Promise<string | null> {
  const id = nextId++
  if (key) keys.set(id, key)
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      keys.delete(id)
      lastError = 'timed out'
      resolve(null)
    }, SYNTH_TIMEOUT_MS + text.length * SYNTH_MS_PER_CHAR)
    pending.set(id, (url) => {
      clearTimeout(timer)
      resolve(url)
    })
    worker!.postMessage({ type: 'synth', id, text, rate } satisfies WorkerIn)
  })
}

/**
 * Generate these lines in the background, one at a time and only while
 * nothing real is waiting, so a sentence MeBo actually has to say is never
 * queued behind more than one of them. The first also absorbs the runtime's
 * warm-up, which otherwise lands on the first real sentence.
 */
export function prewarm(lines: string[]) {
  const todo = lines.filter((t) => t.trim().length <= CACHE_MAX_CHARS)
  const next = async () => {
    if (failed || !worker) return
    if (pending.size) {
      setTimeout(next, 250)
      return
    }
    const text = todo.shift()
    if (text === undefined) return
    const key = keyOf(text)
    if (!cache.has(key)) {
      const url = await request(text, key)
      if (url) URL.revokeObjectURL(url)
    }
    void next()
  }
  void load().then((ok) => {
    if (ok) void next()
  })
}
