import { useStore } from '../../store'
import { Card } from './Card'
import { useMedical, workflowView, type WorkflowId } from './telemetry'

/**
 * The medical agents MeBo routes to. The core is MeBo's Gemma 4 model,
 * and its readout follows the active tool the same way the tool badge does.
 *
 * The two assessments show what is actually happening (Step 23): the live
 * tool call as the bridge reports it, a check in progress while MeBo asks its
 * questions, and otherwise the last assessment's crew member, level and age —
 * read back from MeBo's memory on load, so it survives a reload. Amber means
 * the last outcome needs follow-up (review or above). The rest are named slots
 * for capabilities not built yet — marked PLANNED (dim) so nobody mistakes
 * them for working features.
 */
const LIVE: ReadonlyArray<readonly [WorkflowId, string, string]> = [
  ['cardiovascular', 'Cardiovascular Check', 'Rule-based · HR, BP, symptoms'],
  ['sleep_fatigue', 'Sleep & Fatigue Check', 'Rule-based · sleep, fatigue, mood'],
]

const PLANNED = [
  ['Pharmacy', 'Planned · onboard formulary'],
  ['Radiation', 'Planned · dose tracking & shielding'],
  ['Ground Uplink', 'Planned · flight-surgeon handover'],
] as const

export function AgentTools() {
  const phase = useStore((s) => s.phase)
  const tool = useStore((s) => s.activeTool)
  const online = phase !== 'offline' && phase !== 'boot'
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

  const activity = useMedical((s) => s.activity)
  const checking = useMedical((s) => s.checking)
  const lastAssessment = useMedical((s) => s.lastAssessment)
  const crew = useMedical((s) => s.crew)
  // Re-render twice a minute so "5 min ago" stays true.
  useMedical((s) => Math.floor(s.met / 30))

  return (
    <Card title="Medical Agents" code="AGT-01" state={online ? 'live' : 'standby'} delay={0.3}>
      <div className={`agent agent-core ${busy ? 'agent-busy' : ''}`}>
        <span className={`led ${online ? 'led-on' : ''}`} />
        <span className="agent-name">Companion Core</span>
        <span className="agent-desc">
          {tool ? tool.replace(/[_-]/g, ' ') : busy ? phase : online ? 'ready' : 'offline'}
        </span>
      </div>
      {LIVE.map(([wf, name, desc]) => {
        const v = workflowView({ activity, checking, lastAssessment, crew }, wf)
        const active = v.state === 'running' || v.state === 'checking'
        const led = !online ? '' : v.alert ? 'led-warn' : 'led-on'
        return (
          <div key={wf} className={`agent agent-live ${active ? 'agent-busy' : ''}`} data-workflow={wf} data-state={v.state}>
            <span className={`led ${led}`} />
            <span className="agent-name">{name}</span>
            <span className="agent-desc">{v.text || desc}</span>
          </div>
        )
      })}
      {PLANNED.map(([name, desc]) => (
        <div key={name} className="agent">
          <span className="led" />
          <span className="agent-name">{name}</span>
          <span className="agent-desc">{desc}</span>
        </div>
      ))}
    </Card>
  )
}
