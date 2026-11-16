import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { holdCamera, releaseCamera } from '../camera'
import { frameFrom, type Frame, type Point } from './observe'
import { blockMediaPipeTelemetry } from './no-telemetry'

// MediaPipe would otherwise report usage to Google every minute; see no-telemetry.ts.
blockMediaPipeTelemetry()

/**
 * Face landmark tracking, entirely in this browser.
 *
 * MediaPipe Face Landmarker on the shared, refcounted camera (camera.ts), so
 * hand tracking and the camera blade keep working alongside it. Both halves
 * are local: the WebAssembly runtime is the copy scripts/start.mjs vendors into
 * public/mediapipe (the same one hand tracking uses), and the model is fetched
 * once by `npm run face:download` into public/models/mediapipe. Nothing is
 * requested from any other host, so it works offline.
 *
 * Frames are analysed and dropped. No image is encoded, stored or sent: each
 * video frame becomes one small set of numbers (observe.ts `Frame`), and only
 * those leave this module. The one pixel read is a 16×16 thumbnail of the face
 * region, a few times a second, averaged to a brightness value and cleared.
 */

const WASM_BASE = '/mediapipe'
export const FACE_MODEL_URL = '/models/mediapipe/face_landmarker.task'

/**
 * Analysed frames per second, at most. Spontaneous blinks last only a few
 * hundred milliseconds, so blink measures need a fast rate; the achieved rate
 * is reported with every observation, and a slow machine is flagged
 * (low_frame_rate) rather than trusted.
 */
const TARGET_FPS = 30

/** How often face-region brightness is sampled, for the lighting quality check. */
const LUMA_EVERY_MS = 250

/**
 * Mean brightness (0..255, Rec. 601 luma) of the face's bounding box: the
 * region drawn into a 16×16 canvas, averaged, and discarded at once. Nothing
 * is kept but the one number.
 */
let lumaCanvas: HTMLCanvasElement | null = null
function faceLuma(v: HTMLVideoElement, lm: Point[]): number | null {
  lumaCanvas ??= document.createElement('canvas')
  lumaCanvas.width = 16
  lumaCanvas.height = 16
  const ctx = lumaCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0
  for (const p of lm) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
  }
  const sx = Math.max(0, x0) * v.videoWidth
  const sy = Math.max(0, y0) * v.videoHeight
  const sw = (Math.min(1, x1) - Math.max(0, x0)) * v.videoWidth
  const sh = (Math.min(1, y1) - Math.max(0, y0)) * v.videoHeight
  if (sw < 4 || sh < 4) return null
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, 16, 16)
  const d = ctx.getImageData(0, 0, 16, 16).data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  ctx.clearRect(0, 0, 16, 16)
  return sum / (d.length / 4)
}

export const faceDiag = {
  loading: false,
  ready: false,
  running: false,
  delegate: '' as '' | 'GPU' | 'CPU',
  fps: 0,
  lastError: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__face = faceDiag
}

let landmarker: FaceLandmarker | null = null
let video: HTMLVideoElement | null = null
let generation = 0
/** detectForVideo needs strictly increasing timestamps across sessions. */
let stamp = 0

/** The latest landmarks, for the panel's overlay. Never stored anywhere else. */
export let latestLandmarks: Point[] | null = null

async function ensureModel(): Promise<FaceLandmarker> {
  if (landmarker) return landmarker
  faceDiag.loading = true
  try {
    // A dev server answers a missing file with index.html, which would fail
    // much later as an unreadable model. Say what is actually wrong.
    const head = await fetch(FACE_MODEL_URL, { method: 'HEAD' })
    if (!head.ok || (head.headers.get('content-type') ?? '').includes('text/html')) {
      throw new Error('The face model is missing — run `npm run face:download`.')
    }
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
      runningMode: 'VIDEO' as const,
      numFaces: 1,
      outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    try {
      landmarker = await FaceLandmarker.createFromOptions(vision, options('GPU'))
      faceDiag.delegate = 'GPU'
    } catch {
      // No working GPU delegate: the CPU path is slower but fine at this rate.
      landmarker = await FaceLandmarker.createFromOptions(vision, options('CPU'))
      faceDiag.delegate = 'CPU'
    }
    faceDiag.ready = true
    return landmarker
  } finally {
    faceDiag.loading = false
  }
}

/**
 * Open the camera and start tracking. `onFrame` receives one analysed frame
 * at a time. Rejects with the browser's error on a refused permission
 * (NotAllowedError), so the caller can say so plainly.
 */
export async function startFace(onFrame: (f: Frame) => void): Promise<HTMLVideoElement> {
  stopFace()
  const mine = ++generation
  const v = await holdCamera()
  try {
    await ensureModel()
  } catch (err) {
    releaseCamera()
    faceDiag.lastError = String((err as Error)?.message ?? err)
    throw err
  }
  if (mine !== generation) {
    // Stopped while the model loaded.
    releaseCamera()
    throw new Error('the camera check was stopped')
  }
  video = v
  faceDiag.running = true
  faceDiag.lastError = ''

  let lastAt = 0
  let lumaAt = 0
  let count = 0
  let fpsAt = performance.now()
  const step = () => {
    if (mine !== generation || !video || !landmarker) return
    const now = performance.now()
    if (now - lastAt >= 1000 / TARGET_FPS - 2 && video.videoWidth) {
      lastAt = now
      stamp += 1
      try {
        const r = landmarker.detectForVideo(video, stamp)
        const lm = r.faceLandmarks?.[0] ?? null
        const blend = r.faceBlendshapes?.[0]?.categories
        latestLandmarks = lm
        let luma: number | null = null
        if (lm && now - lumaAt >= LUMA_EVERY_MS) {
          lumaAt = now
          luma = faceLuma(video, lm)
        }
        onFrame(
          frameFrom(
            lm,
            blend ? Object.fromEntries(blend.map((c) => [c.categoryName, c.score])) : null,
            now,
            video.videoWidth / video.videoHeight,
            { height: video.videoHeight, luma },
          ),
        )
      } catch (err) {
        faceDiag.lastError = String((err as Error)?.message ?? err)
      }
      count++
      if (now - fpsAt >= 1000) {
        faceDiag.fps = Math.round((count * 1000) / (now - fpsAt))
        count = 0
        fpsAt = now
      }
    }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(step)
    else requestAnimationFrame(step)
  }
  step()
  return v
}

/** Stop tracking and give the camera hold back. Safe to call any time. */
export function stopFace(): void {
  generation++
  latestLandmarks = null
  faceDiag.running = false
  faceDiag.fps = 0
  if (video) {
    video = null
    releaseCamera()
  }
}
