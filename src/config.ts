/**
 * MeBo configuration.
 *
 * Everything here is read from Vite env vars (.env.local) so no secrets are
 * committed. See .env.example for the full list.
 */

/**
 * Vite inlines a blank `.env` entry as an empty string, not as undefined, so
 * `??` never falls through to the default — and .env.example ships every
 * optional key blank, which is exactly the shape that used to bite. A blank
 * VITE_BACKEND silently selected the direct path and then complained about a
 * missing API key. Treat whitespace-only as unset everywhere in this file.
 */
function str(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

/**
 * Fixed-choice options. An unrecognised value is nearly always a typo, and
 * quietly falling back to the default hides it until it costs you a take.
 */
function choice<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = str(raw)
  if (value === undefined) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  console.warn(
    `[mebo] ${name}="${value}" is not one of ${allowed.join(' | ')} — using "${fallback}".`,
  )
  return fallback
}

/** Same, for the on/off options. Accepts true/false and 1/0. */
function flag(name: string, raw: unknown, fallback: boolean): boolean {
  const value = str(raw)?.toLowerCase()
  if (value === undefined) return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  console.warn(`[mebo] ${name}="${value}" is not true or false — using ${fallback}.`)
  return fallback
}

/**
 * The brain is always the local bridge (bridge/server.mjs), which holds every
 * credential server-side. The old browser-direct mode, which needed an API
 * key in the bundle, was removed before public release (Step 28).
 */
export const BACKEND = 'bridge' as const

/**
 * Where the bridge lives. Derived once here rather than in each of the three
 * places that talk to it, so moving off the default port is a single edit.
 *
 * `same-origin` (a hosted deploy, e.g. Netlify) means the bridge is served by
 * this site itself: the socket is wss://<this host>/ws, since the CDN answers
 * `/` with the page. The HTTP routes (/health, /medical, /tts) live at the
 * socket's origin, whatever path the socket uses.
 */
const configuredBridge = str(import.meta.env.VITE_BRIDGE_URL) ?? 'ws://localhost:8787'
export const BRIDGE_WS_URL =
  configuredBridge === 'same-origin'
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    : configuredBridge
export const BRIDGE_HTTP_URL = new URL(BRIDGE_WS_URL.replace(/^ws/, 'http')).origin

/**
 * Speech output engine.
 *
 * false (default) — the browser's own speechSynthesis. Runs on-device, so
 *   speech starts on the next frame with no request and no download. This is
 *   the fastest option that exists and it's why it's the default.
 *
 * true — ElevenLabs. Noticeably better voice, but every sentence costs a
 *   round trip plus generation, which is the difference between a conversation
 *   and a walkie-talkie. Turn it on when you want the voice more than the pace.
 */
export const USE_ELEVENLABS = flag(
  'VITE_USE_ELEVENLABS',
  import.meta.env.VITE_USE_ELEVENLABS,
  false,
)

/**
 * Speech engine.
 *
 *   'piper' (default) — MeBo's voice: Piper en_US-lessac-medium, a ~63 MB
 *     neural voice run locally in a Web Worker. Fetch it once with
 *     `npm run piper:download` (`npm start` does this for you). If it is
 *     missing or fails, speech falls back to Kokoro, then the system voice.
 *
 *   'system' — the browser's own speechSynthesis. Starts on the next frame,
 *     costs nothing, but is capped by whatever voices the OS ships; on macOS
 *     the British male option is compact Daniel.
 *
 *   'kokoro' — an 82M-parameter neural TTS running entirely in the browser via
 *     ONNX. Four proper British male voices and far better sound, nothing
 *     leaving the machine. MEASURED ON THIS MACHINE at q8/WebGPU it generates
 *     about 2.2x slower than realtime — "Yes, sir?" took 3.3 seconds and a
 *     thirteen-word sentence took nine. That is not a conversation, so it is
 *     not the default. Try `fp32` (see kokoro.ts) before enabling it; int8
 *     quantisation often silently falls back to CPU on WebGPU, which is the
 *     likely cause.
 */
export type TtsEngine = 'piper' | 'kokoro' | 'system'

export const TTS_ENGINE: TtsEngine = choice(
  'VITE_TTS_ENGINE',
  import.meta.env.VITE_TTS_ENGINE,
  ['piper', 'kokoro', 'system'] as const,
  'piper',
)

/**
 * Piper speaking rate. 1 is the voice's natural pace; MeBo defaults a little
 * under it, because calm is most of the bedside manner. Range 0.5 .. 1.5.
 * Can be retuned live from the console — `__mebo.voice.setRate(0.8)` — and
 * the tuned value is remembered in that browser.
 */
export const PIPER_RATE = (() => {
  const raw = str(import.meta.env.VITE_PIPER_RATE)
  if (raw === undefined) return 0.85
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0.5 && n <= 1.5) return n
  console.warn(`[mebo] VITE_PIPER_RATE="${raw}" is not a number from 0.5 to 1.5 — using 0.85.`)
  return 0.85
})()

/**
 * Which Kokoro voice. All four are British male:
 *   bm_george — measured RP baritone, closest to the character
 *   bm_fable  — warmer
 *   bm_lewis  — lower
 *   bm_daniel — brighter
 */
export const KOKORO_VOICE = choice(
  'VITE_KOKORO_VOICE',
  import.meta.env.VITE_KOKORO_VOICE,
  ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const,
  'bm_george',
)
