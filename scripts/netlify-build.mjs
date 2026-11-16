#!/usr/bin/env node
// The Netlify build: what `npm start` prepares on a developer machine, then the
// production build. Puts the Piper voice, the MediaPipe face model and the
// MediaPipe WASM runtime into public/ (all git-ignored), so the CDN serves
// them, and builds the app into dist/.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { ensurePiperVoice } from './piper.mjs'
import { ensureFaceModel } from './face-model.mjs'

const from = 'node_modules/@mediapipe/tasks-vision/wasm'
const to = 'public/mediapipe'
if (existsSync(from) && !existsSync(`${to}/vision_wasm_internal.wasm`)) {
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true })
  console.log('vendored the MediaPipe runtime into public/mediapipe')
}

if (!(await ensurePiperVoice({ quiet: true }))) {
  console.warn('Piper voice unavailable — the deploy will fall back to another voice.')
}
if (!(await ensureFaceModel({ quiet: true }))) {
  console.error('MediaPipe face model could not be fetched; the camera check needs it.')
  process.exit(1)
}

const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(build.status ?? 1)
