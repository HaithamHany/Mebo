import { useStore } from '../../store'
import { usingBridge } from '../../lib/brain'
import { Card } from './Card'
import { useMedical, formatMet, fmt, type CrewSummary } from './telemetry'

/**
 * Mission clock, cabin environment and comms links.
 *
 * The LINKS section is the old SYSTEMS rail moved indoors: the same
 * `connected` list from the bridge, and it still honours `ui.chrome.systems`
 * so the model can hide it exactly as before. The AI core line is the one
 * genuinely live readout on this card — it reports the Claude bridge.
 */
/** Mean of the crew's latest current daily dose readings, or null. */
function crewDose(crew: CrewSummary[]): number | null {
  const doses = crew
    .map((c) => c.metrics.radiation_dose.latest)
    .filter((l) => l && !l.stale)
    .map((l) => l!.value)
  return doses.length ? doses.reduce((a, b) => a + b, 0) / doses.length : null
}

export function MissionStatus() {
  const met = useMedical((s) => s.met)
  const cabin = useMedical((s) => s.cabin)
  const mission = useMedical((s) => s.mission)
  const crew = useMedical((s) => s.crew)
  const phase = useStore((s) => s.phase)
  const connected = useStore((s) => s.connected)
  const showSystems = useStore((s) => s.ui.chrome.systems)

  const online = phase !== 'offline' && phase !== 'boot'

  const rows: [string, string, string][] = [
    ['CABIN P', cabin.pressure.toFixed(1), 'kPa'],
    ['ppO₂', cabin.ppo2.toFixed(1), 'kPa'],
    ['ppCO₂', cabin.ppco2.toFixed(2), 'mmHg'],
    ['TEMP', cabin.temp.toFixed(1), '°C'],
    ['RH', cabin.humidity.toFixed(0), '%'],
    // The crew's latest recorded daily dose, from the medical database.
    ['DOSE', fmt(crewDose(crew), 2), 'mSv/d'],
  ]

  return (
    <Card title="Mission Status" code="MSN-01" state="sim" delay={0.05}>
      <div className="ms-met">
        <span className="ms-met-k">MET</span>
        <span className="ms-met-v">{formatMet(met)}</span>
      </div>
      <div className="ms-meta">
        <span>{mission ? `${mission.destination.toUpperCase()} TRANSIT · DAY ${mission.inflight_days}` : 'MISSION DATA OFFLINE'}</span>
        <span>CREW {mission?.crew_count ?? '—'}</span>
      </div>

      <div className="ms-grid">
        {rows.map(([k, v, u]) => (
          <div key={k} className="ms-cell">
            <span className="ms-k">{k}</span>
            <span className="ms-v">
              {v}
              <small>{u}</small>
            </span>
          </div>
        ))}
      </div>

      <div className="ms-links">
        <div className="ms-link">
          <span className={`led ${online ? 'led-on' : ''}`} />
          AI CORE · {usingBridge ? 'CLAUDE AGENT SDK' : 'CLAUDE API'}
          <span className="ms-link-state">{online ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
        {showSystems && (
          <>
            {connected.map((c) => (
              <div key={c} className="ms-link">
                <span className="led led-on" />
                {c}
              </div>
            ))}
            <div className="ms-link">
              <span className="led led-on" />
              Web
            </div>
          </>
        )}
      </div>
    </Card>
  )
}
