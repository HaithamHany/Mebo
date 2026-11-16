import { motion } from 'framer-motion'
import { answerWith, useFollowUp, type FatigueConcern } from '../../lib/visual/followup'
import { resumeFollowUp } from '../../lib/visual/assessment'
import { concernTone, toneOf } from './visualResult'

/**
 * The sleep and fatigue questions after a camera check, and the combined
 * result (Step 26C) — the right-hand side of the centre view once the camera
 * is off.
 *
 * The result leads with the camera-supported fatigue concern (Step 26D) and
 * exactly what contributed to it, then the rules engine's own escalation
 * guidance, word for word, which the concern never replaces. Nothing here
 * grades anything: every level is the rules engine's or the classifier's.
 */

/** Short names for the answers shown back. The self-harm answer is never shown. */
const SHORT: Record<string, string> = {
  fatigue: 'Tiredness (1–5)',
  dozed_on_task: 'Fell asleep on a task',
  schedule_shift: 'Schedule shifted',
  self_harm: 'Wellbeing question',
}

export function FollowUpPanel() {
  const fu = useFollowUp()
  const asking = fu.status === 'consent' || fu.status === 'asking'
  const q = fu.status === 'asking' && fu.index >= 0 ? fu.questions[fu.index] : null

  if (asking) {
    return (
      <>
        <div className="vstage-step">
          SLEEP & FATIGUE CHECK{q ? ` · QUESTION ${fu.index + 1} OF ${fu.questions.length}` : ''}
        </div>
        {fu.cameraNote && <div className="vstage-gap">{fu.cameraNote}</div>}
        <motion.p key={fu.prompt} className="vstage-say" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
          {fu.prompt}
        </motion.p>
        <div className={`vstage-answers ${fu.awaiting ? '' : 'vstage-answers-wait'}`}>
          {fu.kind === 'consent' && (
            <>
              <button className="chip chip-go" disabled={!fu.awaiting} onClick={() => answerWith('yes')}>Yes, ask me</button>
              <button className="chip chip-go" disabled={!fu.awaiting} onClick={() => answerWith('not now')}>Not now</button>
            </>
          )}
          {fu.kind === 'yes_no' && (
            <>
              <button className="chip chip-go" disabled={!fu.awaiting} onClick={() => answerWith('yes')}>Yes</button>
              <button className="chip chip-go" disabled={!fu.awaiting} onClick={() => answerWith('no')}>No</button>
            </>
          )}
          {fu.kind === 'scale' &&
            [1, 2, 3, 4, 5].map((n) => (
              <button key={n} className="chip chip-go vscale" disabled={!fu.awaiting} onClick={() => answerWith(String(n))}>
                <b>{n}</b> {q?.labels?.[n] ?? ''}
              </button>
            ))}
          {fu.kind !== 'consent' && (
            <button className="chip vskip" disabled={!fu.awaiting} onClick={() => answerWith('skip')}>Skip</button>
          )}
        </div>
        <div className="vstage-now">{fu.awaiting ? 'Listening — say your answer, or choose above' : 'MeBo is speaking…'}</div>
        {fu.heard && <div className="vstage-now">Heard: “{fu.heard}”</div>}
        {Object.keys(fu.answers).length > 0 && (
          <div className="vstage-answered">
            {Object.entries(fu.answers).map(([id, v]) => (
              <span key={id}>
                {SHORT[id] ?? id}: <b>{id === 'self_harm' ? 'answered' : String(v)}</b>
              </span>
            ))}
          </div>
        )}
      </>
    )
  }

  if (fu.status === 'assessing') {
    return (
      <>
        <div className="vstage-step">SLEEP & FATIGUE CHECK</div>
        <p className="vstage-say">Running the rules-based sleep and fatigue assessment…</p>
      </>
    )
  }

  if (fu.status === 'declined') {
    return (
      <>
        <div className="vstage-step">SLEEP & FATIGUE CHECK · DECLINED</div>
        <p className="vstage-say">No sleep and fatigue assessment was made.</p>
        <p className="vstage-explain">
          Without the questions nothing can be concluded about sleep or fatigue — this is not a sign that everything is
          fine. The check can be run at any time.
        </p>
      </>
    )
  }

  if (fu.status === 'stopped') {
    return (
      <>
        <div className="vstage-step">SLEEP & FATIGUE CHECK · STOPPED</div>
        <p className="vstage-say">The questions were stopped before the assessment.</p>
        <p className="vstage-explain">Answers given so far are kept on this computer for 30 minutes.</p>
        <div className="vstage-answers">
          <button className="chip chip-go" onClick={() => void resumeFollowUp()}>Resume the questions</button>
        </div>
      </>
    )
  }

  if (fu.status === 'error') {
    return (
      <>
        <div className="vstage-step">SLEEP & FATIGUE CHECK</div>
        <p className="vstage-say">The assessment could not be completed.</p>
        <div className="vstage-now out">{fu.error}</div>
      </>
    )
  }

  if (fu.status === 'done' && fu.result) return <AssessmentSummary />
  return null
}

const EFFECT: Record<string, string> = {
  sets_floor: 'sets the floor',
  supports: 'supports',
  raised: 'raised the concern',
  elevated: 'elevated',
  within: 'within prototype limit',
  limits: 'limits the camera',
  excluded: 'set aside',
}

/** The combined fatigue concern, and every indicator behind it. */
export function ConcernBlock({ c, hideLevel = false }: { c: FatigueConcern; hideLevel?: boolean }) {
  const rules = c.contributors.filter((x) => x.via === 'rules_engine')
  const camera = c.contributors.filter((x) => x.source === 'camera')
  return (
    <div className={`vconcern vconcern-${concernTone(c.level)}`} data-concern={c.level}>
      <div className="vconcern-k">{hideLevel ? 'WHAT THE FATIGUE CONCERN IS BUILT FROM' : 'COMBINED FATIGUE CONCERN · PROTOTYPE'}</div>
      {!hideLevel && <div className="vconcern-level">{c.level.toUpperCase()}</div>}
      <div className="vconcern-how">
        Rules engine floor: <b>{c.rules_floor}</b>
        {c.raised_by_camera ? ' · raised by the camera' : c.camera.status === 'used' ? ' · camera did not raise it' : ' · camera not used'}
      </div>
      <div className="vconcern-grid">
        {rules.map((x) => (
          <span key={x.indicator}>
            <i>{x.source.replace('_', ' ')}</i> {x.indicator} — {EFFECT[x.effect] ?? x.effect}
          </span>
        ))}
        {!rules.length && <span><i>rules</i> no sleep or fatigue finding</span>}
        {camera.map((x) => (
          <span key={x.indicator} className={x.effect === 'raised' ? 'vconcern-hit' : ''}>
            <i>camera</i> {x.indicator}{x.value ? `: ${x.value}` : ''}{x.threshold ? ` (limit ${x.threshold})` : ''} — {EFFECT[x.effect] ?? x.effect}
            {x.note ? <em> {x.note}</em> : null}
          </span>
        ))}
      </div>
      {c.conflicts.map((t) => <div key={t} className="vstage-gap">{t}</div>)}
      <div className="vconcern-note">
        Camera thresholds are prototype assumptions, not validated. The camera can raise this concern but never lower the rules
        engine's level. Not a diagnosis, an escalation or a fitness-for-duty decision.
      </div>
    </div>
  )
}

/** The combined result: fatigue concern, rules engine guidance, then sleep history and the camera. */
function AssessmentSummary() {
  const fu = useFollowUp()
  const r = fu.result!
  const lines = fu.context?.context ?? []
  const sleep = lines.filter((l) => /^(Sleep|Self-rated|Fallen asleep|Mission)/.test(l))
  const camera = lines.find((l) => l.startsWith('Camera'))
  const source = fu.context?.nasa_background?.[0]
  return (
    <>
      {fu.concern && <ConcernBlock c={fu.concern} />}
      <div className={`vstage-result vstage-tone-${toneOf(r.level)}`}>
        SLEEP & FATIGUE · RULES ENGINE: {r.level.toUpperCase()} · {r.status.toUpperCase()}
      </div>
      {r.escalation.guidance && <p className="vstage-guidance">{r.escalation.guidance}</p>}
      {r.status === 'incomplete' && (
        <div className="vstage-gap">
          {r.escalation.incomplete ?? 'The assessment is incomplete.'}
          {r.missing.some((m) => m.required) && ` Missing: ${r.missing.filter((m) => m.required).map((m) => m.label.toLowerCase()).join('; ')}.`}
        </div>
      )}
      {r.evidence.length > 0 && (
        <div className="vsection">
          <span className="vsection-k">Findings</span>
          {r.evidence.slice(0, 5).map((e) => (
            <span key={e.title} className={`vfinding vstage-tone-${toneOf(e.level)}`}>
              <i>{e.level.toUpperCase()}</i> {e.title}
            </span>
          ))}
        </div>
      )}
      {(r.next_assessments?.length ?? 0) > 0 && (
        <div className="vsection">
          <span className="vsection-k">Next steps</span>
          {r.next_assessments!.slice(0, 3).map((n) => <span key={n.text}>{n.text}</span>)}
        </div>
      )}
      {!r.evidence.length && r.summary && <p className="vstage-explain">{r.summary}</p>}
      {sleep.length > 0 && (
        <div className="vsection">
          <span className="vsection-k">Sleep and self-report</span>
          {sleep.map((l) => <span key={l}>{l}</span>)}
        </div>
      )}
      {camera && (
        <div className="vsection">
          <span className="vsection-k">Camera — did not change the rules engine's result</span>
          <span>{camera}</span>
        </div>
      )}
      {source && <div className="vstage-source">Background: {source.citation}</div>}
    </>
  )
}
