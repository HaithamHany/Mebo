/**
 * Fetch MediaPipe's Face Landmarker model for the camera assessment.
 *
 * The model (~3.7 MB, float16) comes from Google's official MediaPipe model
 * bucket, at a versioned path (`/1/`), and lands in public/models/mediapipe/.
 * The page serves it from its own origin, so face tracking runs entirely in
 * the browser and keeps working offline once fetched — no frame, landmark or
 * image ever leaves the machine. The folder is gitignored (models/).
 *
 *   npm run face:download            fetch it if missing
 *   npm run face:download -- --force fetch it again
 *
 * Also called from scripts/start.mjs, so `npm start` fetches it on the first
 * run. A failure is reported and the app still starts; only the camera
 * assessment is unavailable, and its panel says so.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MODEL = 'face_landmarker.task'
const URL_ =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
export const DIR = 'public/models/mediapipe'

/**
 * A .task file is a zip archive (the official one carries two padding bytes
 * before the zip signature); a truncated download or an HTML error page is not.
 */
function check(path) {
  const size = statSync(path).size
  if (size < 1_000_000) throw new Error(`model is only ${size} bytes`)
  const head = readFileSync(path).subarray(0, 8).toString('latin1')
  if (!head.includes('PK\x03\x04')) throw new Error('model is not a .task archive')
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Returns true when the model is present and valid afterwards. */
export async function ensureFaceModel({ force = false, quiet = false } = {}) {
  const log = quiet ? () => {} : (m) => console.log(m)
  mkdirSync(DIR, { recursive: true })
  const path = `${DIR}/${MODEL}`
  if (!force && existsSync(path)) {
    try {
      check(path)
      return true
    } catch (err) {
      log(`  ${MODEL} looks damaged (${err.message}) — fetching it again.`)
    }
  }
  try {
    log(`  downloading ${MODEL} …`)
    const res = await fetch(URL_, { redirect: 'follow' })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${URL_}`)
    // Written beside the target and renamed into place, so an interrupted
    // download never leaves a half-file that looks like a finished one.
    const tmp = `${path}.part`
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
    check(tmp)
    renameSync(tmp, path)
    log(`  ${MODEL} ok · ${statSync(path).size.toLocaleString()} bytes · sha256 ${sha256(path)}`)
    return true
  } catch (err) {
    console.warn(`  could not fetch ${MODEL}: ${err.message}`)
    return false
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`MediaPipe Face Landmarker → ${DIR}`)
  const ok = await ensureFaceModel({ force: process.argv.includes('--force') })
  if (ok) console.log('  ready.')
  process.exit(ok ? 0 : 1)
}
