/**
 * Score.
 *
 * One cue, a local file under public/audio/:
 *   work — a quiet cue that loops while a tool is running
 *
 * There is no intro music. The MeBo start-up score (boot-music) and the
 * opening bed (ambient) that played under the old power-up are gone: MeBo's
 * activation is a soft synthesised chime (sfx.ts `boot`) and its spoken
 * introduction, the way Baymax switches on — not a film-trailer swell.
 *
 * Kevin MacLeod (incompetech.com), CC BY 4.0 — see public/audio/CREDITS.md.
 *
 * Everything degrades quietly: if the file is missing the cue simply doesn't
 * play.
 */

import { hasAudioFile } from './audioFiles'

type Cue = 'work'

type Track = {
  el: HTMLAudioElement
  fade: number | null
}

const tracks = new Map<Cue, Track>()
/** Cues whose file failed to load. Retrying only spends another 404. */
const missing = new Set<Cue>()
const ALL: Cue[] = ['work']
let enabled = false

/** Resting levels. Music sits well under the voice — it is atmosphere, not a
 *  soundtrack, and MeBo has to stay intelligible over it. */
const LEVEL: Record<Cue, number> = {
  work: 0.11,
}

/**
 * Where each cue currently wants to sit, before ducking. Kept separately from
 * the element volume so the two systems compose: a tool starting while MeBo
 * is speaking brings the work cue in at its ducked level rather than at full,
 * and it rises the rest of the way when MeBo stops.
 */
const want: Record<Cue, number> = { work: 0 }

let ducked = false
/** How far the bed drops under the voice. */
const DUCK = 0.35

function track(cue: Cue): Track | null {
  if (!enabled || missing.has(cue)) return null
  // A cue whose file does not ship is never requested.
  if (!hasAudioFile(cue)) {
    missing.add(cue)
    return null
  }
  let t = tracks.get(cue)
  if (!t) {
    const el = new Audio(`/audio/${cue}.mp3`)
    el.preload = 'auto'
    // It covers an operation of unknown length, so it repeats.
    el.loop = true
    el.volume = 0
    // A missing file is not an error worth surfacing — the interface just
    // runs without that layer.
    el.addEventListener(
      'error',
      () => {
        tracks.delete(cue)
        missing.add(cue)
      },
      { once: true },
    )
    t = { el, fade: null }
    tracks.set(cue, t)
  }
  return t
}

/** Must be called from a user gesture — browsers block audio before one. */
export function enable() {
  enabled = true
  // Warm the file so the cue starts on time rather than after a buffer.
  ALL.forEach(track)
}

/** The level a cue should actually be at right now. */
function level(cue: Cue): number {
  return ducked ? want[cue] * DUCK : want[cue]
}

function fadeTo(cue: Cue, to: number, ms: number) {
  const t = track(cue)
  if (!t) return
  if (t.fade !== null) cancelAnimationFrame(t.fade)
  const from = t.el.volume
  const start = performance.now()
  const step = () => {
    const k = Math.min(1, (performance.now() - start) / ms)
    t.el.volume = from + (to - from) * k
    if (k < 1) t.fade = requestAnimationFrame(step)
    else {
      t.fade = null
      if (to === 0) t.el.pause()
    }
  }
  if (to > 0 && t.el.paused) void t.el.play().catch(() => {})
  t.fade = requestAnimationFrame(step)
}

/** Set a cue's resting level and ramp to wherever that lands it. */
function set(cue: Cue, to: number, ms: number) {
  want[cue] = to
  fadeTo(cue, level(cue), ms)
}

export function stopAll() {
  ALL.forEach((c) => {
    want[c] = 0
    // Only touch cues that exist — asking for one that was never played would
    // otherwise construct an Audio element purely in order to silence it.
    if (tracks.has(c)) fadeTo(c, 0, 600)
  })
}

/** The work cue rises while a tool runs and falls the moment it's done. */
export function working(on: boolean) {
  set('work', on ? LEVEL.work : 0, on ? 900 : 1400)
}

/** Pull the bed down while MeBo speaks so the voice stays clear. */
export function duck(on: boolean) {
  if (ducked === on) return
  ducked = on
  // Down quickly, back up slowly: the drop has to be out of the way before the
  // first syllable, but a fast recovery is audible as a swell.
  ALL.forEach((c) => {
    if (tracks.has(c)) fadeTo(c, level(c), on ? 250 : 900)
  })
}
