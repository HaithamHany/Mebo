import { useEffect, useRef } from 'react'
import { Card } from './Card'
import { current, deviates, fmt, liveHeartRate, selectedCrew, useMedical } from './telemetry'

/**
 * A synthetic PQRST complex, phase 0..1 through one beat. Sums of gaussians —
 * the standard cheap ECG model — which is plenty for a display trace and
 * makes no pretence of being a recording.
 */
function ecg(p: number): number {
  const g = (mu: number, sigma: number, a: number) =>
    a * Math.exp(-((p - mu) ** 2) / (2 * sigma * sigma))
  return (
    g(0.18, 0.025, 0.12) +  // P
    g(0.285, 0.008, -0.1) + // Q
    g(0.3, 0.01, 1.0) +     // R
    g(0.315, 0.009, -0.22) + // S
    g(0.52, 0.045, 0.28)    // T
  )
}

/** Pulse-oximeter plethysmograph: a fast upstroke and a dicrotic notch. */
function pleth(p: number): number {
  const q = (p + 0.72) % 1
  const up = Math.exp(-((q - 0.12) ** 2) / 0.004)
  const notch = 0.35 * Math.exp(-((q - 0.36) ** 2) / 0.006)
  return up + notch + 0.25 * Math.exp(-q * 3)
}

/** Read colours from CSS so the traces follow the stylesheet's tokens. */
const cssVar = (el: Element, name: string, fallback: string) =>
  getComputedStyle(el).getPropertyValue(name).trim() || fallback

/**
 * The two traces, drawn the way bedside monitors do it: a sweep that writes
 * left to right and erases a short gap ahead of itself, rather than a strip
 * that scrolls. Heart rate is read from the store each frame without
 * subscribing, so the canvas never causes a React render.
 */
function Traces() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let w = 0
    let h = 0
    let x = 0
    let beat = 0
    let last = performance.now()
    let prevE = 0
    let prevP = 0
    const red = cssVar(canvas, '--med-red', '#ff5d73')
    const cyan = cssVar(canvas, '--med-cyan', '#62d0ff')

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      x = 0
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const SPEED = 70 // px per second
    const GAP = 14

    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      // The selected crew member's latest recorded heart rate. With no current
      // reading the traces run flat — drawing a rhythm with no data behind it
      // would be inventing one.
      const hr = liveHeartRate()
      const steps = Math.max(1, Math.round(dt * SPEED))
      const ecgMid = h * 0.36
      const plMid = h * 0.9

      for (let i = 0; i < steps; i++) {
        if (hr) beat = (beat + hr / 60 / SPEED) % 1
        const e = hr ? ecgMid - ecg(beat) * h * 0.28 : ecgMid
        const pl = hr ? plMid - pleth(beat) * h * 0.2 : plMid

        ctx.clearRect(x, 0, GAP, h)
        if (x > 0) {
          ctx.lineWidth = 1.6
          ctx.strokeStyle = red
          ctx.shadowColor = red
          ctx.shadowBlur = 6
          ctx.beginPath()
          ctx.moveTo(x - 1, prevE)
          ctx.lineTo(x, e)
          ctx.stroke()

          ctx.strokeStyle = cyan
          ctx.shadowColor = cyan
          ctx.lineWidth = 1.3
          ctx.beginPath()
          ctx.moveTo(x - 1, prevP)
          ctx.lineTo(x, pl)
          ctx.stroke()
        }
        prevE = e
        prevP = pl
        x += 1
        if (x >= w) x = 0
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={ref} className="cardio-canvas" />
}

export function Cardio() {
  const c = useMedical(selectedCrew)
  const hr = current(c, 'heart_rate')
  const sys = current(c, 'bp_systolic')
  const dia = current(c, 'bp_diastolic')
  const hrDelta = c?.metrics.heart_rate.deviation?.delta ?? null
  const beatSeconds = hr ? 60 / Math.max(30, hr) : 0

  const cls = (k: Parameters<typeof deviates>[1]) => (deviates(c, k) ? 'cv-v out' : 'cv-v')
  const latest = c?.metrics.heart_rate.latest

  return (
    <Card title="Cardiovascular" code="CV-01" state="sim" delay={0.1} className="cardio">
      <div className="cardio-who">
        <span>{c ? `${c.role} · ${c.callsign}` : '—'}</span>
        <span>
          {latest
            ? `DAY ${latest.mission_day}${latest.stale ? ' · NO CURRENT READING' : ''}`
            : 'NO DATA'}
        </span>
      </div>

      <Traces />

      <div className="cv-grid">
        <div className="cv-cell cv-hr">
          <span className="cv-k">
            <span className="heart" style={{ animationDuration: hr ? `${beatSeconds}s` : '0s' }}>
              ♥
            </span>
            HR
          </span>
          <span className={cls('heart_rate')}>{fmt(hr)}</span>
          <span className="cv-u">bpm</span>
        </div>
        <div className="cv-cell">
          <span className="cv-k">NIBP</span>
          <span className={deviates(c, 'bp_systolic') || deviates(c, 'bp_diastolic') ? 'cv-v out' : 'cv-v'}>
            {sys === null && dia === null ? '—' : `${fmt(sys)}/${fmt(dia)}`}
          </span>
          <span className="cv-u">mmHg</span>
        </div>
        <div className="cv-cell cv-spo2">
          <span className="cv-k">SpO₂</span>
          <span className={cls('spo2')}>{fmt(current(c, 'spo2'))}</span>
          <span className="cv-u">%</span>
        </div>
        <div className="cv-cell">
          <span className="cv-k">RESP</span>
          <span className={cls('respiratory_rate')}>{fmt(current(c, 'respiratory_rate'))}</span>
          <span className="cv-u">/min</span>
        </div>
        <div className="cv-cell">
          <span className="cv-k">TEMP</span>
          <span className={cls('body_temperature')}>{fmt(current(c, 'body_temperature'), 1)}</span>
          <span className="cv-u">°C</span>
        </div>
        <div className="cv-cell" title="Heart rate minus this person's pre-flight baseline. Statistical, not clinical.">
          <span className="cv-k">HR Δ BASE</span>
          <span className={cls('heart_rate')}>
            {hrDelta === null ? '—' : `${hrDelta > 0 ? '+' : ''}${hrDelta.toFixed(1)}`}
          </span>
          <span className="cv-u">bpm</span>
        </div>
      </div>
    </Card>
  )
}
