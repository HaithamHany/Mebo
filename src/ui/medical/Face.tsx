import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'
import { speakingSince } from '../../lib/tts'

/**
 * MeBo's face: two separate eyes and a small mouth, nothing else. Used as the
 * brand mark and, larger, floating over the core in the centre of the scene.
 *
 * It blinks on its own every few seconds. While MeBo's speech is audible,
 * the mouth follows the amplitude of that output (the TTS level the app pumps
 * into the store every frame), so it opens on syllables and closes in the
 * gaps; it is closed while listening, thinking or waiting. Step 27 removed
 * the line that used to join the eyes; nothing draws one.
 *
 * The mouth sits below the eyes inside the same viewBox height (the svg
 * overflows), so the eyes keep exactly their old size and position.
 */
const MOUTH = { cy: 22, rx: 5, ryClosed: 1.3, ryOpen: 6 }

export function FaceGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="-60 -20 120 40" aria-hidden="true">
      <ellipse cx="-36" cy="0" rx="11" ry="11" className="face-eye" />
      <ellipse cx="36" cy="0" rx="11" ry="11" className="face-eye" />
      <ellipse cx="0" cy={MOUTH.cy} rx={MOUTH.rx} ry={MOUTH.ryClosed} className="face-mouth" />
    </svg>
  )
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * How open the mouth is (0 closed … 1 widest), eased from the speech level:
 * opens quickly, closes a little slower, so it reads as articulation rather
 * than flicker. Closed at once when speech stops.
 */
function useMouth(speaking: boolean, level: number) {
  const open = useRef(0)
  if (!speaking) {
    open.current = 0
    return 0
  }
  if (reducedMotion()) return 0.35
  // Measured on Piper: speech levels run about 0.15 (soft) to 0.8 (loud), median
  // about 0.55. That range is spread over the mouth's opening so it varies
  // syllable by syllable instead of sitting wide open.
  const target = Math.min(1, Math.max(0, (level - 0.15) / 0.65))
  const k = target > open.current ? 0.55 : 0.3
  open.current += (target - open.current) * k
  return open.current
}

export function CoreFace() {
  const phase = useStore((s) => s.phase)
  const level = useStore((s) => s.level)
  const visible = useStore((s) => s.ui.reactor.visible)
  const [blink, setBlink] = useState(false)

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const schedule = () => {
      t = setTimeout(() => {
        setBlink(true)
        setTimeout(() => setBlink(false), 140)
        schedule()
      }, 3200 + Math.random() * 3600)
    }
    schedule()
    return () => clearTimeout(t)
  }, [])

  // Only while speech is actually audible: from the first sound to the end of
  // playback, an interruption or a cancel — whichever speaker is talking.
  const speaking = speakingSince() > 0
  const open = useMouth(speaking, level)

  if (phase === 'offline' || phase === 'boot' || !visible) return null

  // Asleep in standby: the eyes close to slits until he is called. The eyes
  // keep their size while speaking: only the mouth articulates.
  const ry = blink ? 1.2 : phase === 'dormant' ? 3.5 : 11
  const mouthRy = MOUTH.ryClosed + (MOUTH.ryOpen - MOUTH.ryClosed) * open
  // A wider, flatter shape when nearly closed; rounder as it opens.
  const mouthRx = MOUTH.rx - open * 1.2
  return (
    <div className={`core-face core-face-${phase}`} aria-hidden="true" data-speaking={speaking ? 'true' : 'false'}>
      <svg viewBox="-60 -20 120 40">
        <ellipse cx="-36" cy="0" rx="11" ry={ry} className="face-eye" />
        <ellipse cx="36" cy="0" rx="11" ry={ry} className="face-eye" />
        <ellipse
          cx="0"
          cy={MOUTH.cy}
          rx={mouthRx}
          ry={mouthRy}
          className="face-mouth"
          data-open={open > 0.05 ? 'true' : 'false'}
        />
      </svg>
    </div>
  )
}
