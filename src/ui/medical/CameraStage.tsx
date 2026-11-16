import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { faceDiag } from '../../lib/visual/face'
import { ALERTNESS } from '../../lib/visual/observe'
import { TASKS, cancelVisualCheck, collapseVisual, useVisual } from '../../lib/visual/assessment'
import { cancelFollowUp, useFollowUp } from '../../lib/visual/followup'
import { FollowUpPanel } from './FollowUpPanel'
import { useMedical } from './telemetry'
import { CameraPreview } from './CameraPreview'
import { resultView } from './visualResult'

/**
 * The guided camera check, in the centre of the screen (Step 26C).
 *
 * While a check runs it is the main thing happening, so it takes the centre:
 * the live picture large, what MeBo has just asked, the task checklist, live
 * feedback on the conditions, and a Stop control. The rest of the console
 * dims behind it but stays in place. When the check ends the result is shown
 * here first; Done (or Escape, or a timeout) returns the camera to the
 * Camera Assessment card, where the result stays.
 *
 * The camera frame carries a shared layoutId with the side card's frame, so
 * expanding and collapsing are one continuous movement, not a popup.
 */

/** How long a finished view stays before folding back by itself. */
const LINGER_MS: Record<string, number> = { done: 45_000, cancelled: 1_800, denied: 7_000, error: 7_000 }

export function CameraStage() {
  const v = useVisual()
  const fu = useFollowUp()
  const crew = useMedical((s) => s.crew)
  const who = (id: string) => crew.find((c) => c.id === id)?.callsign ?? id.toUpperCase()
  const live = v.status === 'starting' || v.status === 'running'
  // The sleep and fatigue questions that follow the camera (Step 26C).
  const asking = fu.status === 'consent' || fu.status === 'asking' || fu.status === 'assessing'
  const following = fu.status !== 'idle'

  // Fold back by itself after a while once everything has ended — never mid-question.
  useEffect(() => {
    if (!v.expanded || live || asking) return
    const t = setTimeout(collapseVisual, following ? 90_000 : (LINGER_MS[v.status] ?? 5_000))
    return () => clearTimeout(t)
  }, [v.expanded, live, asking, following, v.status, v.endedAt, fu.status])

  const stateLabel = live
    ? (STATE[v.status] ?? 'LIVE')
    : asking
      ? 'QUESTIONS'
      : fu.status === 'done'
        ? 'ASSESSED'
        : (STATE[fu.status] ?? STATE[v.status] ?? 'STANDBY')

  return (
    <AnimatePresence>
      {v.expanded && (
        <motion.div
          key="stage"
          className="vstage"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.35, delay: 0.1 } }}
          transition={{ duration: 0.35 }}
          role="dialog"
          aria-label="Guided camera check"
        >
          <div className="vstage-dim" />
          <motion.section
            className="vstage-card"
            initial={{ y: 18, filter: 'blur(6px)' }}
            animate={{ y: 0, filter: 'blur(0px)' }}
            exit={{ y: 12, filter: 'blur(6px)', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 220, damping: 26 }}
          >
            <header className="mc-head vstage-head">
              <span className="mc-code">VIS-01</span>
              <span className="mc-title">GUIDED CAMERA CHECK{v.crewId ? ` · ${who(v.crewId)}` : ''}</span>
              <span className={`mc-state ${live || asking ? 'mc-state-live' : 'mc-state-standby'}`}>{stateLabel}</span>
            </header>

            <div className={`vstage-body ${live ? '' : 'vstage-body-result'}`}>
              <div className="vstage-left">
              <motion.div layoutId="vis-camera" className={`cam-frame vstage-frame ${live ? 'cam-active' : ''}`}>
                {live && <CameraPreview dot={2.4} />}
                <span className="cam-k cam-tl" />
                <span className="cam-k cam-tr" />
                <span className="cam-k cam-bl" />
                <span className="cam-k cam-br" />
                {live && <span className="cam-scan" />}
                {!live && <span className="cam-msg">CAMERA OFF · NOTHING WAS RECORDED</span>}
                {live && v.step >= 0 && (
                  <span className="cam-progress">
                    <span style={{ transform: `scaleX(${v.progress})` }} />
                  </span>
                )}
              </motion.div>
              {/* Once the questions begin, the camera result moves under the frame. */}
              {!live && following && <CameraSummary who={who} />}
              </div>

              <div className="vstage-side">
                {live ? <LivePanel /> : following ? <FollowUpPanel /> : <ResultPanel who={who} />}
              </div>
            </div>

            <footer className="vstage-foot">
              <span className="cam-note">
                OBSERVATION ONLY — NOT A DIAGNOSIS OR FITNESS FOR DUTY · PROCESSED ON THIS COMPUTER, NOT RECORDED
              </span>
              {live ? (
                <button className="chip chip-go vstage-btn" onClick={cancelVisualCheck}>
                  Stop check
                </button>
              ) : asking ? (
                <button className="chip chip-go vstage-btn" onClick={cancelFollowUp}>
                  Stop questions
                </button>
              ) : (
                <button className="chip chip-go vstage-btn" onClick={collapseVisual} autoFocus>
                  Done
                </button>
              )}
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const STATE: Record<string, string> = {
  starting: 'STARTING',
  running: 'LIVE',
  done: 'COMPLETE',
  cancelled: 'STOPPED',
  denied: 'NO PERMISSION',
  error: 'ERROR',
  declined: 'DECLINED',
  stopped: 'STOPPED',
}

function LivePanel() {
  const v = useVisual()
  // The tracker's frame rate lives outside React; sample it with the readout.
  const [fps, setFps] = useState(faceDiag.fps)
  useEffect(() => setFps(faceDiag.fps), [v.live])

  const step = v.step >= 0 ? TASKS[v.step] : null
  return (
    <>
      <div className="vstage-step">{step ? `STEP ${v.step + 1} OF ${TASKS.length} · ${step.label.toUpperCase()}` : 'STARTING THE CAMERA'}</div>
      <motion.p key={v.instruction} className="vstage-say" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        {v.instruction}
      </motion.p>
      {v.status_line && <div className="vstage-now">{v.status_line}</div>}

      <ol className="vstage-tasks">
        {TASKS.map((t, i) => {
          const state = v.step === i ? 'now' : v.done[t.id] === true ? 'done' : v.done[t.id] === false ? 'missed' : 'todo'
          return (
            <li key={t.id} className={`vtask vtask-${state}`}>
              <span className="vtask-mark">{state === 'done' ? '✓' : state === 'missed' ? '–' : i + 1}</span>
              {t.label}
              {state === 'now' && <span className="vtask-bar"><span style={{ transform: `scaleX(${v.progress})` }} /></span>}
            </li>
          )
        })}
      </ol>

      <div className="vstage-quality">{hints(v.live, fps).map((h) => <span key={h.text} className={h.ok ? '' : 'out'}>{h.text}</span>)}</div>
    </>
  )
}

/** Live feedback on the conditions, in words. Same limits as the measures use. */
function hints(live: ReturnType<typeof useVisual.getState>['live'], fps: number) {
  if (!live.face) return [{ ok: false, text: 'Face not in view — move into the frame' }]
  const out: { ok: boolean; text: string }[] = []
  out.push(
    live.iodPx !== null && live.iodPx < ALERTNESS.MIN_IOD_PX
      ? { ok: false, text: 'Move a little closer' }
      : { ok: true, text: 'Distance good' },
  )
  out.push(
    live.yaw !== null && Math.abs(live.yaw) > 15 ? { ok: false, text: 'Face the camera' } : { ok: true, text: 'Facing the camera' },
  )
  if (live.luma !== null) {
    out.push(
      live.luma < ALERTNESS.LUMA_DARK
        ? { ok: false, text: 'More light on your face' }
        : live.luma > ALERTNESS.LUMA_BRIGHT
          ? { ok: false, text: 'Light too bright' }
          : { ok: true, text: 'Lighting good' },
    )
  }
  out.push(
    fps > 0 && fps < ALERTNESS.GOOD_FPS ? { ok: false, text: `Tracking slowly (${fps} fps)` } : { ok: true, text: 'Tracking well' },
  )
  if (live.eyeOpen !== null) out.push({ ok: true, text: `Eyes ${Math.round(live.eyeOpen * 100)}% open` })
  return out
}

/** The camera result, compact, under the frame while the questions run and after. */
function CameraSummary({ who }: { who: (id: string) => string }) {
  const v = useVisual()
  if (v.status === 'denied' || v.status === 'error' || !v.last) {
    return (
      <div className="vcam-summary">
        <span className="vsection-k">Camera</span>
        <span className="out">{v.status === 'denied' ? 'Camera permission refused — no camera observation.' : v.error || 'No camera observation.'}</span>
      </div>
    )
  }
  const r = resultView(v.last, who)
  if (!r) return null
  return (
    <div className="vcam-summary">
      <span className={`vsection-k vstage-tone-${r.tone}`}>Camera · {r.status}</span>
      <div className="vstage-tiles">
        {r.tiles.filter((t) => t.label !== 'Measurement quality').map((t) => (
          <div key={t.label} className="vtile" title={t.note}>
            <span className="vtile-k">{t.label}</span>
            <span className="vtile-v">{t.value}</span>
          </div>
        ))}
      </div>
      {r.reasons.length > 0 && <span className="out">Quality: {r.reasons.join(' · ')}</span>}
    </div>
  )
}

function ResultPanel({ who }: { who: (id: string) => string }) {
  const v = useVisual()
  if (v.status !== 'done') {
    // Stopped, refused or failed: say so plainly; nothing was filed.
    return (
      <>
        <div className="vstage-step">{STATE[v.status] ?? ''}</div>
        <p className="vstage-say">{v.instruction || v.error}</p>
        <div className="vstage-now">No observation was saved.</div>
      </>
    )
  }
  const r = resultView(v.last, who)
  if (!r) return null
  return (
    <>
      <div className={`vstage-result vstage-tone-${r.tone}`}>{r.status}</div>
      <div className="vstage-tiles">
        {r.tiles.map((t) => (
          <div key={t.label} className="vtile" title={t.note}>
            <span className="vtile-k">{t.label}</span>
            <span className="vtile-v">{t.value}</span>
          </div>
        ))}
      </div>
      {r.reasons.length > 0 && <div className="vstage-now out">Quality: {r.reasons.join(' · ')}</div>}
      {r.explanation && <p className="vstage-explain">{r.explanation}</p>}
      {r.nextStep && <p className="vstage-next">Next: {r.nextStep}</p>}
      {!v.saved && <div className="vstage-now out">{v.error || 'Not saved — the medical service could not be reached.'}</div>}
    </>
  )
}
