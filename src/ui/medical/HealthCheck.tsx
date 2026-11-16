import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { BRIDGE_HTTP_URL } from '../../config'
import {
  STAGES, beginReview, chooseCamera, chooseCrew, closeHealthCheck, openHealthCheck, startQuestions, takeHealthCheckRequest,
  useHealthCheck,
} from '../../lib/healthcheck'
import { useFollowUp } from '../../lib/visual/followup'
import { resumeFollowUp, useVisual } from '../../lib/visual/assessment'
import { FollowUpPanel, ConcernBlock } from './FollowUpPanel'
import { useMedical, type CrewSummary } from './telemetry'
import { concernTone, toneOf } from './visualResult'

/**
 * The guided health check (Step 27), in the centre of the screen.
 *
 * One stage at a time, one main action per stage, and the stage bar on top:
 * Crew → Health Review → Questions → Camera (optional) → Results. The
 * crew member being assessed is always named in the header. While the camera
 * runs, the camera view (CameraStage) takes the centre instead, then hands
 * back.
 *
 * Display only: every level, finding and piece of guidance shown here comes
 * from the rules engine or the Step 26D fatigue concern, unchanged.
 */
export function HealthCheck() {
  const hc = useHealthCheck()
  const cameraUp = useVisual((s) => s.expanded)
  const crew = useMedical((s) => s.crew)
  const who = crew.find((c) => c.id === hc.crewId)
  const open = hc.stage !== 'off' && !cameraUp

  // From "Start Health Check" on the opening screen, once the crew is loaded.
  useEffect(() => {
    if (crew.length && takeHealthCheckRequest()) openHealthCheck()
  }, [crew.length])

  useEffect(() => {
    if (hc.stage === 'off') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useVisual.getState().expanded) closeHealthCheck()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hc.stage])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="hc"
          className="vstage hc"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.3 } }}
          role="dialog"
          aria-label="Guided health check"
        >
          <div className="vstage-dim" />
          <motion.section
            className="vstage-card hc-card"
            initial={{ y: 18, filter: 'blur(6px)' }}
            animate={{ y: 0, filter: 'blur(0px)' }}
            transition={{ type: 'spring', stiffness: 220, damping: 26 }}
          >
            <header className="mc-head vstage-head">
              <span className="mc-code">HC-01</span>
              <span className="mc-title">
                GUIDED HEALTH CHECK
                {who && hc.stage !== 'crew' ? <span className="hc-who"> · ASSESSING {who.callsign} ({who.display_name})</span> : null}
              </span>
              <span className="mc-state mc-state-sim">SIMULATED CREW DATA</span>
            </header>
            <Stages />
            <div className="hc-body">
              {hc.stage === 'crew' && <CrewChoice />}
              {hc.stage === 'review' && who && <Review c={who} />}
              {hc.stage === 'questions' && <Questions />}
              {hc.stage === 'camera' && <CameraOffer />}
              {hc.stage === 'results' && <Results />}
            </div>
            <footer className="vstage-foot hc-foot">
              <span className="cam-note">PROTOTYPE · NOT A DIAGNOSIS OR FITNESS FOR DUTY · THE CREW MEDICAL OFFICER DECIDES</span>
              {hc.stage !== 'results' && (
                <button className="chip vstage-btn hc-cancel" onClick={closeHealthCheck}>
                  Cancel
                </button>
              )}
            </footer>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Stages() {
  const stage = useHealthCheck((s) => s.stage)
  const camera = useHealthCheck((s) => s.camera)
  const at = STAGES.findIndex((s) => s.id === stage)
  return (
    <ol className="hc-stages" aria-label="Progress">
      {STAGES.map((s, i) => {
        const state = i === at ? 'now' : i < at ? 'done' : 'todo'
        const skipped = s.id === 'camera' && camera === 'skipped' && i < at
        return (
          <li key={s.id} className={`hc-stage hc-stage-${state}`} aria-current={state === 'now' ? 'step' : undefined}>
            <span className="hc-stage-mark">{state === 'done' ? (skipped ? '–' : '✓') : i + 1}</span>
            {s.label}
            {s.optional && <em> (optional)</em>}
          </li>
        )
      })}
    </ol>
  )
}

/** Data-grounded, one line: role, then the profile notes from the database. */
const describe = (c: CrewSummary) => {
  const s = c.metrics.sleep_duration
  const sleep = s?.latest ? `Last sleep ${s.latest.value.toFixed(1)} h${s.baseline ? ` (baseline ${s.baseline.mean.toFixed(1)} h)` : ''}.` : ''
  return { notes: c.profile_notes, sleep }
}

function CrewChoice() {
  const crew = useMedical((s) => s.crew)
  const chosen = useHealthCheck((s) => s.crewId)
  const name = crew.find((c) => c.id === chosen)
  return (
    <>
      <p className="vstage-say">Who is having the health check?</p>
      <p className="hc-hint">These are four simulated crew members of a fictional Mars transit. Their records are synthetic demonstration data.</p>
      <div className="hc-crew" role="radiogroup" aria-label="Crew member">
        {crew.map((c) => {
          const d = describe(c)
          return (
            <button
              key={c.id}
              role="radio"
              aria-checked={c.id === chosen}
              className={`hc-person ${c.id === chosen ? 'hc-person-on' : ''}`}
              onClick={() => chooseCrew(c.id)}
              onDoubleClick={() => void beginReview()}
            >
              <span className="hc-person-top">
                <b>{c.callsign}</b>
                <span>{c.role}</span>
                <span className="hc-sim">SIMULATED</span>
              </span>
              <span className="hc-person-name">{c.display_name}</span>
              {d.notes && <span className="hc-person-notes">{d.notes}</span>}
              {d.sleep && <span className="hc-person-sleep">{d.sleep}</span>}
            </button>
          )
        })}
        {!crew.length && <span className="hc-hint">Loading the crew from the medical database…</span>}
      </div>
      <div className="hc-actions">
        <button className="chip chip-go hc-primary" disabled={!name} onClick={() => void beginReview()} autoFocus>
          {name ? `Continue as ${name.callsign}` : 'Choose a crew member'}
        </button>
      </div>
    </>
  )
}

const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : v.toFixed(d))

function Review({ c }: { c: CrewSummary }) {
  const say = useHealthCheck((s) => s.say)
  const m = c.metrics
  const tiles: { k: string; v: string; note?: string }[] = [
    { k: 'Last sleep', v: m.sleep_duration?.latest ? `${fmt(m.sleep_duration.latest.value)} h` : '—', note: m.sleep_duration?.baseline ? `baseline ${fmt(m.sleep_duration.baseline.mean)} h` : undefined },
    {
      k: c.trend?.metric ? `${c.metrics[c.trend.metric]?.name ?? c.trend.metric.replace('_', ' ')} trend` : 'Trend',
      v: c.trend?.slope_per_week !== null && c.trend?.slope_per_week !== undefined ? `${c.trend.slope_per_week > 0 ? '+' : ''}${fmt(c.trend.slope_per_week, 2)} ${c.trend.unit}/wk` : '—',
      note: '14 days',
    },
    { k: 'Heart rate', v: m.heart_rate?.latest ? `${fmt(m.heart_rate.latest.value, 0)} bpm` : '—', note: m.heart_rate?.baseline ? `baseline ${fmt(m.heart_rate.baseline.mean, 0)}` : undefined },
    { k: 'SpO₂', v: m.spo2?.latest ? `${fmt(m.spo2.latest.value)} %` : '—' },
    { k: 'Mood (self-report)', v: m.mood?.latest ? `${fmt(m.mood.latest.value)} / 5` : '—', note: m.mood?.baseline ? `baseline ${fmt(m.mood.baseline.mean)}` : undefined },
    { k: 'Activity', v: m.activity?.latest ? `${fmt(m.activity.latest.value, 0)} ${m.activity.unit}` : '—' },
  ]
  return (
    <>
      <p className="vstage-say">{say}</p>
      <div className="vsection-k">Recent records · medical database (synthetic)</div>
      <div className="hc-tiles">
        {tiles.map((t) => (
          <div key={t.k} className="vtile">
            <span className="vtile-k">{t.k}</span>
            <span className="vtile-v">{t.v}</span>
            {t.note && <span className="hc-tile-note">{t.note}</span>}
          </div>
        ))}
      </div>
      <div className="hc-actions">
        <button className="chip chip-go hc-primary" onClick={() => void startQuestions()} autoFocus>
          Start questions
        </button>
      </div>
    </>
  )
}

function Questions() {
  const fu = useFollowUp()
  const starting = fu.status === 'idle' || (fu.status === 'asking' && fu.index < 0)
  return (
    <div className="hc-questions">
      {starting ? <p className="vstage-say">Getting your questions…</p> : <FollowUpPanel />}
    </div>
  )
}

function CameraOffer() {
  const hc = useHealthCheck()
  const fu = useFollowUp()
  if (fu.status === 'assessing' || hc.camera === 'done' || hc.camera === 'skipped') {
    return <p className="vstage-say">Running the rules-based sleep and fatigue assessment…</p>
  }
  return (
    <>
      <p className="vstage-say">{hc.say}</p>
      <p className="hc-hint">
        The camera measures eye closure (PERCLOS) and long eye closures. It can only add to the fatigue concern, never reduce
        it, and it never changes the clinical assessment.
      </p>
      <div className="hc-actions">
        <button className="chip chip-go hc-primary" onClick={() => chooseCamera('start')} autoFocus>
          Start camera check
        </button>
        <button className="chip chip-go" onClick={() => chooseCamera('skip')}>
          Skip
        </button>
      </div>
    </>
  )
}

type History = { at: string; level: string; status: string; workflow: string; assessment_id: string }[]

function Results() {
  const fu = useFollowUp()
  const crewId = useHealthCheck((s) => s.crewId)
  const [history, setHistory] = useState<History>([])
  useEffect(() => {
    if (fu.status !== 'done') return
    fetch(`${BRIDGE_HTTP_URL}/medical/memory/${encodeURIComponent(crewId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => m && setHistory([...(m.recent_assessments ?? [])].reverse()))
      .catch(() => {})
  }, [fu.status, crewId])

  if (fu.status === 'stopped' || fu.status === 'error') {
    return (
      <>
        <p className="vstage-say">{fu.status === 'stopped' ? 'The health check was stopped before the assessment.' : 'The assessment could not be completed.'}</p>
        {fu.error && <div className="vstage-now out">{fu.error}</div>}
        <p className="hc-hint">Answers given so far are kept on this computer for 30 minutes.</p>
        <div className="hc-actions">
          {fu.status === 'stopped' && (
            <button className="chip chip-go hc-primary" onClick={() => { closeHealthCheck(); void resumeFollowUp() }}>
              Resume the questions
            </button>
          )}
          <button className="chip chip-go" onClick={closeHealthCheck}>Back to the dashboard</button>
        </div>
      </>
    )
  }
  if (fu.status !== 'done' || !fu.result) return <p className="vstage-say">Preparing your results…</p>

  const r = fu.result
  const c = fu.concern
  const lines = fu.context?.context ?? []
  const sleep = lines.filter((l) => /^(Sleep|Self-rated|Fallen asleep|Mission)/.test(l))
  const missing = [
    ...r.missing.filter((m) => m.required).map((m) => `${m.label} — not answered or no data`),
    ...(c && c.camera.status !== 'used' ? [`Camera — not used: ${c.camera.reasons.join('; ')}`] : []),
    ...(c && c.camera.status === 'used' && c.camera.quality !== 'good' ? [`Camera — quality ${c.camera.quality}: it can support moderate at most`] : []),
  ]
  const nasa = fu.context?.nasa_background ?? []
  return (
    <div className="hc-results">
      {/* A. The conclusion: clinical escalation and the experimental fatigue concern, kept apart. */}
      <section className="hc-sec">
        <h3 className="hc-h">A · Conclusion</h3>
        <div className="hc-conclusion">
          <div className={`hc-verdict vstage-tone-${toneOf(r.level)}`}>
            <span className="hc-verdict-k">CLINICAL ESCALATION · RULES ENGINE</span>
            <span className="hc-verdict-v">{r.level.toUpperCase()}</span>
            <span className="hc-verdict-s">Assessment {r.status}</span>
          </div>
          {c && (
            <div className={`hc-verdict hc-verdict-exp vstage-tone-${concernTone(c.level)}`}>
              <span className="hc-verdict-k">FATIGUE CONCERN · EXPERIMENTAL, CAMERA-SUPPORTED</span>
              <span className="hc-verdict-v">{c.level.toUpperCase()}</span>
              <span className="hc-verdict-s">
                {c.raised_by_camera ? 'Raised by the camera' : c.camera.status === 'used' ? 'Camera did not raise it' : 'Camera not used'} · never lowers the clinical level
              </span>
            </div>
          )}
        </div>
        {r.status === 'incomplete' && <div className="vstage-gap">{r.escalation.incomplete ?? 'The assessment is incomplete.'}</div>}
      </section>

      {/* B. Why. */}
      <section className="hc-sec">
        <h3 className="hc-h">B · Why MeBo reached this</h3>
        {r.evidence.length > 0 ? (
          <div className="vsection">
            <span className="vsection-k">Rules engine findings</span>
            {r.evidence.map((e) => (
              <span key={e.title} className={`vfinding vstage-tone-${toneOf(e.level)}`}>
                <i>{e.level.toUpperCase()}</i> {e.title}
              </span>
            ))}
          </div>
        ) : (
          r.summary && <p className="vstage-explain">{r.summary}</p>
        )}
        {sleep.length > 0 && (
          <div className="vsection">
            <span className="vsection-k">Sleep history and self-report</span>
            {sleep.map((l) => <span key={l}>{l}</span>)}
          </div>
        )}
        {c && <ConcernBlock c={c} hideLevel />}
        {missing.length > 0 && (
          <div className="vstage-gap">
            <b>Missing or low-quality evidence:</b> {missing.join(' · ')}
          </div>
        )}
      </section>

      {/* C. What to do next — the rules engine's own wording. */}
      <section className="hc-sec">
        <h3 className="hc-h">C · What to do next</h3>
        {r.escalation.guidance && <p className="vstage-guidance">{r.escalation.guidance}</p>}
        {(r.next_assessments?.length ?? 0) > 0 && (
          <ul className="hc-next">
            {r.next_assessments!.map((n) => <li key={n.text}>{n.text}</li>)}
          </ul>
        )}
      </section>

      {/* D. Supporting information. */}
      <details className="hc-sec hc-details">
        <summary className="hc-h">D · Supporting information — sources, provenance, history</summary>
        {nasa.map((p) => <div key={p.passage_id} className="vstage-source">NASA: {p.citation}</div>)}
        {c?.references?.filter((x) => x.kind !== 'NASA').map((x) => <div key={x.id} className="vstage-source">{x.citation}</div>)}
        <div className="vstage-source">
          Provenance: assessment {r.trace.assessment_id}
          {c ? ` · fatigue concern ${c.concern_id}` : ''}
          {c?.camera.observation_id ? ` · camera ${c.camera.observation_id}` : ''} · rules engine unchanged; camera supplementary.
        </div>
        {history.length > 0 && (
          <div className="vsection">
            <span className="vsection-k">Assessment history (crew memory)</span>
            {history.slice(0, 6).map((h) => (
              <span key={h.assessment_id + h.at}>
                {new Date(h.at).toLocaleString()} · {h.workflow.replace('_', ' ')} · {h.level.toUpperCase()} · {h.status}
              </span>
            ))}
          </div>
        )}
      </details>

      <div className="hc-actions">
        <button className="chip chip-go hc-primary" onClick={closeHealthCheck}>
          Finish Health Check
        </button>
      </div>
    </div>
  )
}
