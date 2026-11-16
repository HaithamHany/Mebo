import { Card } from './Card'
import { current, deviates, fmt, useMedical, type CrewSummary, type MetricCode } from './telemetry'

/** A tiny inline trend line, scaled to its own min/max. */
function Spark({ data }: { data: number[] }) {
  if (data.length < 2) return <svg className="spark" viewBox="0 0 60 16" />
  const lo = Math.min(...data)
  const hi = Math.max(...data)
  const span = hi - lo || 1
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * 60},${14 - ((v - lo) / span) * 12}`)
    .join(' ')
  return (
    <svg className="spark" viewBox="0 0 60 16" preserveAspectRatio="none">
      <polyline points={pts} />
    </svg>
  )
}

function Val({ c, k, digits = 0 }: { c: CrewSummary; k: MetricCode; digits?: number }) {
  return <span className={deviates(c, k) ? 'out' : ''}>{fmt(current(c, k), digits)}</span>
}

const SHOWN: MetricCode[] = ['heart_rate', 'spo2', 'body_temperature']

/**
 * The crew roster, from the medical data service. Each row is a button:
 * choosing a crew member points the cardiovascular monitor at them. Amber
 * marks a value far from that person's own pre-flight baseline — a
 * statistical cue only. A dash means no current reading.
 */
export function CrewHealth() {
  const crew = useMedical((s) => s.crew)
  const status = useMedical((s) => s.status)
  const selected = useMedical((s) => s.selected)
  const select = useMedical((s) => s.select)

  return (
    <Card title="Crew Health" code="MED-01" state="sim" delay={0.15}>
      <div className="crew-head">
        <span>CREW</span>
        <span>HR</span>
        <span>SpO₂</span>
        <span>T°C</span>
        <span>TREND</span>
      </div>
      {status !== 'ready' && (
        <p className="mc-note">
          {status === 'loading' ? 'Loading crew data…' : 'Medical data service offline — start the bridge (npm start).'}
        </p>
      )}
      {crew.map((c) => {
        const missing = SHOWN.some((k) => current(c, k) === null)
        const flagged = SHOWN.some((k) => deviates(c, k))
        return (
          <button
            key={c.id}
            className={`crew-row ${selected === c.id ? 'crew-sel' : ''}`}
            onClick={() => select(c.id)}
            aria-pressed={selected === c.id}
            title={`${c.display_name} — synthetic profile${missing ? ' · no current wearable reading' : ''}`}
          >
            <span className="crew-id">
              <span className={`led ${flagged ? 'led-warn' : missing ? '' : 'led-on'}`} />
              <b>{c.role}</b>
              {c.callsign}
            </span>
            <Val c={c} k="heart_rate" />
            <Val c={c} k="spo2" />
            <Val c={c} k="body_temperature" digits={1} />
            <Spark data={c.trend.daily.map((d) => d.mean)} />
          </button>
        )
      })}
      <p className="mc-note">
        Synthetic data, fictional crew. Amber: over 2 SD from the person's own pre-flight baseline — statistical, not
        clinical. — : no current reading.
      </p>
    </Card>
  )
}
