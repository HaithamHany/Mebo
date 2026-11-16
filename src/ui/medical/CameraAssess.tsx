import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '../../store'
import { TASKS, cancelVisualCheck, loadLatestVisual, resumeFollowUp, runVisualCheck, useVisual } from '../../lib/visual/assessment'
import { useFollowUp } from '../../lib/visual/followup'
import { concernTone, toneOf } from './visualResult'
import { useHealthCheck } from '../../lib/healthcheck'
import { useMedical } from './telemetry'
import { Card } from './Card'
import { CameraPreview } from './CameraPreview'
import { ago, resultView } from './visualResult'

/**
 * Camera assessment: the guided visual check's home on the console.
 *
 * The camera opens only for a check — started here or by MeBo — and the check
 * itself runs in the centre of the screen (CameraStage), growing out of this
 * card's frame and folding back into it. Here, afterwards, the latest result
 * stays: who, when, the quality status and the values that matter, labelled
 * as an observation. After a reload the latest stored result is read back
 * from the medical service.
 *
 * It still mirrors the existing look/watch capture and hand tracking, which
 * are untouched.
 */
export function CameraAssess() {
  const looking = useStore((s) => s.looking)
  const gestures = useStore((s) => s.gestures)
  const v = useVisual()
  const selected = useMedical((s) => s.selected)
  // During the guided health check its own camera step is the only way in.
  const hcStage = useHealthCheck((s) => s.stage)
  const crew = useMedical((s) => s.crew)
  const bridgeUp = useMedical((s) => s.status === 'ready')

  const checking = v.status === 'starting' || v.status === 'running'
  const active = checking || Boolean(looking) || gestures
  const who = (id: string) => crew.find((c) => c.id === id)?.callsign ?? id.toUpperCase()

  // The latest stored check, once the medical service is reachable.
  useEffect(() => {
    if (bridgeUp) void loadLatestVisual()
  }, [bridgeUp])

  // Keep "12 min ago" current.
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const msg = checking
    ? 'CHECK IN PROGRESS · CENTRE VIEW'
    : looking
      ? `ASSESSING — ${looking.toUpperCase()}`
      : gestures
        ? 'CAMERA ON · HAND TRACKING'
        : v.status === 'denied'
          ? 'CAMERA PERMISSION REFUSED'
          : v.status === 'error'
            ? v.error.toUpperCase().slice(0, 80)
            : 'CAMERA OFF · OPENS ONLY ON REQUEST'

  const frameInner = (
    <>
      {checking && !v.expanded && <CameraPreview />}
      <span className="cam-k cam-tl" />
      <span className="cam-k cam-tr" />
      <span className="cam-k cam-bl" />
      <span className="cam-k cam-br" />
      <span className="cam-scan" />
      <span className="cam-msg">{msg}</span>
    </>
  )

  const r = resultView(v.last, who)
  const fu = useFollowUp()

  return (
    <Card title="Camera Assessment" code="VIS-01" state={active ? 'live' : 'standby'} delay={0.25} className="camassess">
      {/* Shares its layoutId with the centre view's frame, so the check grows
          out of this frame and folds back into it. */}
      {v.expanded ? (
        <div className={`cam-frame ${active ? 'cam-active' : ''}`}>{frameInner}</div>
      ) : (
        <motion.div layoutId="vis-camera" className={`cam-frame ${active ? 'cam-active' : ''}`}>
          {frameInner}
        </motion.div>
      )}

      {r && !checking && (
        <div className="cam-readout cam-result" data-tone={r.tone}>
          <span className="cam-result-head">
            <span className={`led ${r.tone === 'good' ? 'led-on' : 'led-warn'}`} />
            {r.who ? `${r.who} · ` : ''}
            {r.status}
          </span>
          {r.at && <span className="cam-when">{ago(r.at, now)}</span>}
          {r.tiles
            .filter((t) => t.label !== 'Measurement quality')
            .map((t) => (
              <span key={t.label} className="cam-kv" title={t.note}>
                <i>{t.label}</i> {t.value}
              </span>
            ))}
          {r.reasons.length > 0 && <span className="cam-alert out">{r.reasons.slice(0, 2).join(' · ')}</span>}
          <LinkedAssessment />
          <span className="cam-note">OBSERVATION ONLY — NOT A DIAGNOSIS OR FITNESS FOR DUTY{v.saved ? '' : ' · NOT SAVED'}</span>
        </div>
      )}
      {/* A health check without a camera result still leaves its assessment here (Step 27). */}
      {!r && (fu.resumable || (fu.status === 'done' && fu.result)) && !checking && <LinkedAssessment />}

      <div className="chips" data-linked={fu.status}>
        {TASKS.map((t, i) => {
          const done = v.done[t.id]
          const state = checking && v.step === i ? 'chip-now' : done === true ? 'chip-done' : done === false ? 'chip-missed' : ''
          return (
            <span key={t.id} className={`chip chip-task ${state}`}>
              {t.label}
            </span>
          )
        })}
        {checking ? (
          <button className="chip chip-go" onClick={cancelVisualCheck}>
            Stop
          </button>
        ) : (
          <button
            className="chip chip-go"
            disabled={!selected || Boolean(looking) || hcStage !== 'off'}
            title={selected ? `Guided camera check for ${who(selected)}` : 'Select a crew member first'}
            onClick={() => void runVisualCheck(selected)}
          >
            Start check{selected ? ` · ${who(selected)}` : ''}
          </button>
        )}
      </div>
    </Card>
  )
}

/**
 * The sleep and fatigue assessment that followed the camera check (Step 26C),
 * or why there is none: in progress, declined, or interrupted with answers
 * kept to resume.
 */
function LinkedAssessment() {
  const fu = useFollowUp()
  const active = fu.status === 'consent' || fu.status === 'asking' || fu.status === 'assessing'
  if (active) return <span className="cam-linked">SLEEP & FATIGUE QUESTIONS IN PROGRESS</span>
  if (fu.status === 'done' && fu.result) {
    return (
      <>
        {fu.concern && (
          <span className={`cam-linked cam-concern vstage-tone-${concernTone(fu.concern.level)}`}>
            FATIGUE CONCERN: {fu.concern.level.toUpperCase()}
            {fu.concern.raised_by_camera ? ' · RAISED BY CAMERA' : fu.concern.camera.status === 'used' ? '' : ' · CAMERA NOT USED'}
          </span>
        )}
        <span className={`cam-linked vstage-tone-${toneOf(fu.result.level)}`}>
          SLEEP & FATIGUE (RULES): {fu.result.level.toUpperCase()} · {fu.result.status.toUpperCase()} · {ago(fu.at)}
        </span>
      </>
    )
  }
  if (fu.status === 'declined') return <span className="cam-linked out">SLEEP QUESTIONS DECLINED — NO ASSESSMENT MADE</span>
  if (fu.resumable || fu.status === 'stopped') {
    return (
      <span className="cam-linked out">
        SLEEP QUESTIONS NOT FINISHED{' '}
        <button className="chip chip-go cam-resume" onClick={() => void resumeFollowUp()}>
          Resume
        </button>
      </span>
    )
  }
  return null
}
