/**
 * Fetch MeBo's voice: Piper `en_US-lessac-medium`.
 *
 * The model (~63 MB) and its JSON config come from the official Piper voice
 * repository on Hugging Face, pinned to the v1.0.0 tag so the bytes cannot
 * change under us. They land in public/models/piper/, which the page serves
 * from its own origin — synthesis then runs entirely in the browser, with
 * nothing leaving the machine. The folder is gitignored (models/, *.onnx);
 * 63 MB of weights does not belong in the repository.
 *
 *   npm run piper:download            fetch whatever is missing
 *   npm run piper:download -- --force fetch both again
 *
 * Also called from scripts/start.mjs, so `npm start` fetches the voice on the
 * first run. Any failure is reported and the app still starts — the speech
 * layer falls back to Kokoro, then to the system voice.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const VOICE = 'en_US-lessac-medium'
const BASE =
  'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium'
export const DIR = 'public/models/piper'

/** Smallest plausible model. A truncated download or an HTML error page is far below this. */
const MIN_MODEL_BYTES = 50_000_000

const files = [
  { name: `${VOICE}.onnx.json`, check: checkConfig },
  { name: `${VOICE}.onnx`, check: checkModel },
]

function checkConfig(path) {
  const cfg = JSON.parse(readFileSync(path, 'utf8'))
  if (!cfg.phoneme_id_map || !cfg.audio?.sample_rate) {
    throw new Error('config has no phoneme_id_map or sample_rate')
  }
  if (cfg.phoneme_type && cfg.phoneme_type !== 'espeak') {
    throw new Error(`unexpected phoneme_type "${cfg.phoneme_type}"`)
  }
}

function checkModel(path) {
  const size = statSync(path).size
  if (size < MIN_MODEL_BYTES) throw new Error(`model is only ${size} bytes`)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function download(name) {
  const url = `${BASE}/${name}?download=true`
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)

  const total = Number(res.headers.get('content-length')) || 0
  const chunks = []
  let got = 0
  let shown = -1
  for await (const chunk of res.body) {
    chunks.push(chunk)
    got += chunk.length
    const pct = total ? Math.floor((got / total) * 100) : -1
    if (pct >= 0 && pct >= shown + 10 && process.stdout.isTTY) {
      shown = pct
      process.stdout.write(`\r  ${name}: ${pct}%   `)
    }
  }
  if (process.stdout.isTTY && total) process.stdout.write('\n')

  // Written beside the target and renamed into place, so an interrupted
  // download never leaves a half-file that looks like a finished one.
  const tmp = `${DIR}/${name}.part`
  writeFileSync(tmp, Buffer.concat(chunks))
  return tmp
}

/** Returns true when both files are present and valid afterwards. */
export async function ensurePiperVoice({ force = false, quiet = false } = {}) {
  const log = quiet ? () => {} : (m) => console.log(m)
  mkdirSync(DIR, { recursive: true })
  let ok = true
  for (const { name, check } of files) {
    const path = `${DIR}/${name}`
    if (!force && existsSync(path)) {
      try {
        check(path)
        continue
      } catch (err) {
        log(`  ${name} looks damaged (${err.message}) — fetching it again.`)
      }
    }
    try {
      log(`  downloading ${name} …`)
      const tmp = await download(name)
      check(tmp)
      renameSync(tmp, path)
      log(`  ${name} ok · ${statSync(path).size.toLocaleString()} bytes · sha256 ${sha256(path)}`)
    } catch (err) {
      ok = false
      console.warn(`  could not fetch ${name}: ${err.message}`)
    }
  }
  return ok
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Piper voice ${VOICE} → ${DIR}`)
  const ok = await ensurePiperVoice({ force: process.argv.includes('--force') })
  if (ok) console.log('  ready.')
  process.exit(ok ? 0 : 1)
}
