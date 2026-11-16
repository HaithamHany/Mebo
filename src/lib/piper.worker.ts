/// <reference lib="webworker" />
/**
 * Piper speech synthesis, off the main thread.
 *
 * Runs the VITS model through onnxruntime-web's WASM backend and phonemizes
 * with espeak-ng (the `phonemizer` package) — the same phonemizer Piper itself
 * is built on, so the phoneme ids line up with the model's phoneme_id_map.
 *
 * Why a worker: single-threaded WASM inference blocks for a few hundred
 * milliseconds a sentence, and the voice loop's VAD and barge-in run on the
 * main thread. It also gives Piper its own copy of the ONNX runtime, so it can
 * never fight Kokoro (which configures the shared runtime for WebGPU) over
 * global settings.
 *
 * Everything here is local: the model and config are fetched from this origin
 * (public/models/piper), and the runtime's own .wasm is bundled by Vite.
 */
import * as ort from 'onnxruntime-web'
// Loaded as a verbatim file rather than bundled. phonemizer is an Emscripten
// build with espeak-ng's data packed inline, and running it through the
// bundler breaks that data's initialisation — the language table comes up
// empty and every call throws `Invalid language identifier: "en-us". Should
// be one of: .` (the same failure vite.config.ts describes for pre-bundling).
// `?url` emits the file untouched and the worker imports it natively.
import phonemizerUrl from 'phonemizer?url'

type Phonemizer = typeof import('phonemizer')
let phonemizer: Promise<Phonemizer> | null = null
const phonemize = async (text: string, voice: string) => {
  phonemizer ??= import(/* @vite-ignore */ phonemizerUrl) as Promise<Phonemizer>
  return (await phonemizer).phonemize(text, voice)
}

type PiperConfig = {
  audio: { sample_rate: number }
  espeak: { voice: string }
  inference: { noise_scale: number; length_scale: number; noise_w: number }
  phoneme_id_map: Record<string, number[]>
}

export type WorkerIn =
  | { type: 'init'; model: string; config: string }
  | { type: 'synth'; id: number; text: string; rate: number }

export type WorkerOut =
  | { type: 'progress'; value: number }
  | { type: 'ready'; sampleRate: number }
  | { type: 'error'; error: string }
  | { type: 'audio'; id: number; wav: ArrayBuffer; seconds: number; ms: number }
  | { type: 'fail'; id: number; error: string }

let session: ort.InferenceSession | null = null
let cfg: PiperConfig | null = null

const post = (m: WorkerOut, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer)

/** Fetch with download progress, since the model is ~63 MB on a cold cache. */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  // A dev server answering a missing file with index.html is the usual way a
  // model "loads" as garbage. Catch it here rather than as an ONNX parse error.
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`${url} is missing — run \`npm run piper:download\``)
  }
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer())

  const out = new Uint8Array(total)
  const reader = res.body.getReader()
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out.set(value, got)
    got += value.length
    post({ type: 'progress', value: got / total })
  }
  return out
}

async function init(modelUrl: string, configUrl: string) {
  const res = await fetch(configUrl)
  if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) {
    throw new Error(`${configUrl} is missing — run \`npm run piper:download\``)
  }
  cfg = (await res.json()) as PiperConfig

  // Threads need SharedArrayBuffer, which needs cross-origin isolation, which
  // would break the framed blades. One thread is ample for a medium voice.
  ort.env.wasm.numThreads = self.crossOriginIsolated ? 0 : 1
  ort.env.logLevel = 'error'

  const bytes = await fetchBytes(modelUrl)
  session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  post({ type: 'ready', sampleRate: cfg.audio.sample_rate })
}

/**
 * espeak drops punctuation when it phonemizes, but Piper was trained with the
 * clause punctuation left in the phoneme stream — it is what produces the
 * pauses and the rising "?". So split on punctuation, phonemize the words, and
 * put the marks back.
 */
const PUNCT = /(\s*[.,;:!?¡¿—–…"“”()]+\s*)/

async function toPhonemes(text: string, voice: string): Promise<string> {
  let out = ''
  for (const part of text.split(PUNCT)) {
    if (!part) continue
    if (PUNCT.test(part)) {
      out = out.trimEnd() + part.trim() + ' '
    } else if (part.trim()) {
      out += (await phonemize(part, voice)).join(' ') + ' '
    }
  }
  return out.trim()
}

/** Piper's id layout: BOS, then every phoneme followed by the pad id, then EOS. */
function toIds(phonemes: string, map: Record<string, number[]>): number[] {
  const pad = map['_'][0]
  const ids = [map['^'][0], pad]
  for (const ch of phonemes) {
    const id = map[ch]
    if (id) ids.push(id[0], pad)
  }
  ids.push(map['$'][0])
  return ids
}

/** Float samples to a 16-bit mono WAV, which every <audio> element can play. */
function toWav(samples: Float32Array, rate: number): ArrayBuffer {
  // Normalise quiet output toward a consistent level, never amplify noise wildly.
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  const gain = peak > 0.01 ? Math.min(3, 0.9 / peak) : 1

  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

async function synth(text: string, rate: number) {
  if (!session || !cfg) throw new Error('piper is not loaded')
  const t0 = performance.now()
  const ids = toIds(await toPhonemes(text, cfg.espeak.voice), cfg.phoneme_id_map)
  if (ids.length <= 3) throw new Error('nothing pronounceable in the text')

  const { noise_scale, length_scale, noise_w } = cfg.inference
  // Speech rate is the inverse of Piper's length scale: 0.9 means ten percent
  // slower, i.e. every phoneme held ten percent longer.
  const scales = Float32Array.from([noise_scale, length_scale / rate, noise_w])
  const out = await session.run({
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', scales, [3]),
  })
  const samples = out[session.outputNames[0]].data as Float32Array
  return {
    wav: toWav(samples, cfg.audio.sample_rate),
    seconds: samples.length / cfg.audio.sample_rate,
    ms: performance.now() - t0,
  }
}

/**
 * One synthesis at a time. onmessage is async, so without this a second
 * sentence started while the first awaited its phonemes, two session.run
 * calls overlapped, and ONNX Runtime rejected one ("Session already started",
 * "Session mismatch"). That sentence fell back to the system voice, and three
 * in a row latched Piper off for the page — MeBo's voice changed after any
 * burst of sentences, such as the end of a camera check.
 */
let queue: Promise<void> = Promise.resolve()

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data
  queue = queue.then(async () => {
    if (m.type === 'init') {
      try {
        await init(m.model, m.config)
      } catch (err) {
        post({ type: 'error', error: String((err as Error)?.message ?? err) })
      }
    } else if (m.type === 'synth') {
      try {
        const r = await synth(m.text, m.rate)
        post({ type: 'audio', id: m.id, ...r }, [r.wav])
      } catch (err) {
        post({ type: 'fail', id: m.id, error: String((err as Error)?.message ?? err) })
      }
    }
  })
}
