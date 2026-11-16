import { useStore } from '../store'
import { FaceGlyph } from './medical/Face'

/**
 * The start gate.
 *
 * Browsers refuse to play audio or start speech synthesis until the user has
 * interacted with the page, so something has to be clicked before MeBo can
 * make a sound. Rather than hide that behind a permissions banner, it's the
 * cold open: a dead interface waiting to be switched on.
 *
 * Deliberately NOT wrapped in AnimatePresence, and the reason is worth keeping.
 *
 * It used to be, for the sake of a blur-and-fade on the way out, and the exit
 * never completed — the node reached opacity 0 and then stayed in the DOM for
 * the rest of the session. Which would be a cosmetic non-event, except this is
 * a `position: fixed; inset: 0` button: invisible, unremovable, and the topmost
 * hit-testable thing under every single point on the screen.
 *
 * Everything that aims by hit-testing died on it. Hand control resolves its
 * target with elementFromPoint, so every pinch — focus, grab, drag, close —
 * landed on an invisible button instead of a blade, silently, with no error and
 * nothing on screen to suggest why. It cost an entire evening of looking at the
 * gesture code, which was fine.
 *
 * Two attempted fixes failed and are worth recording so nobody re-attempts
 * them. Giving the child a `key` did not make the exit complete. Adding a
 * phase-dependent `pointerEvents` did not help either, because AnimatePresence
 * renders an exiting child from a frozen snapshot of its last props — inside
 * that copy the phase is forever 'offline', so a guard written in terms of it
 * can never fire.
 *
 * A plain conditional cannot strand anything. The fade-in survives because
 * mounting is not the dangerous direction; the fade-out is gone, and the boot
 * sequence takes the screen immediately anyway, so there is nothing to see.
 */
export function Ignition({ onStart }: { onStart: (intent: 'check' | 'explore') => void }) {
  const phase = useStore((s) => s.phase)
  if (phase !== 'offline') return null

  // The opening screen (Step 27): what MeBo is, and the two ways in. The
  // whole surface still activates (a click anywhere, or a clap, explores), so
  // the browser's one-gesture audio unlock happens whichever is chosen.
  return (
    <div className="ignition" onClick={() => onStart('explore')}>
      {/*
        Spun by CSS rather than framer. As a motion element with
        `repeat: Infinity` it was one of the things keeping the exit from ever
        finishing — AnimatePresence waits for a leaving subtree's animations,
        and an infinite one never ends.
      */}
      <span className="ignition-ring" />
      <div className="ignition-label onboard">
        <FaceGlyph className="onboard-face" />
        <h1 className="onboard-title">MeBo</h1>
        <p className="onboard-tag">Your AI Medical Companion for Deep-Space Missions</p>
        <p className="onboard-lead">
          Monitor astronaut health, complete guided assessments, and explore how an offline medical companion can support a
          crew far from Earth.
        </p>
        <div className="onboard-actions">
          <button
            className="onboard-btn onboard-primary"
            autoFocus
            onClick={(e) => {
              e.stopPropagation()
              onStart('check')
            }}
          >
            Start Health Check
          </button>
          <button
            className="onboard-btn"
            onClick={(e) => {
              e.stopPropagation()
              onStart('explore')
            }}
          >
            Explore Crew Health
          </button>
        </div>
        <span className="onboard-badge">NASA Space Apps Challenge 2026 — Prototype · Simulated Crew Data</span>
        <span className="ignition-sub">MeBo speaks — turn your sound on · say “MeBo” to talk to it</span>
      </div>
    </div>
  )
}
