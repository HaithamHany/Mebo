import { useEffect } from 'react'
import { useStore } from '../../store'
import { useMedical } from './telemetry'
import { MissionStatus } from './MissionStatus'
import { CrewHealth } from './CrewHealth'
import { AgentTools } from './AgentTools'
import { Cardio } from './Cardio'
import { Anatomy } from './Anatomy'
import { CameraAssess } from './CameraAssess'
import { CameraStage } from './CameraStage'
import { HealthCheck } from './HealthCheck'

/**
 * The two instrument columns either side of the core.
 *
 * Mounted only once MeBo is up, so the cards assemble after the boot
 * sequence rather than sitting behind it. The telemetry clock runs from here
 * for the same reason — nothing is ticking while the ignition screen waits.
 */
export function MedicalConsole() {
  const phase = useStore((s) => s.phase)
  const up = phase !== 'offline' && phase !== 'boot'

  useEffect(() => {
    if (!up) return
    // Crew data from the medical data service; refreshed so that new records
    // appear without a reload. The one-second tick only moves the clock and
    // the (still simulated) cabin readouts.
    const { load, tick } = useMedical.getState()
    void load()
    const refresh = setInterval(() => void useMedical.getState().load(), 60_000)
    const clock = setInterval(tick, 1000)
    return () => {
      clearInterval(refresh)
      clearInterval(clock)
    }
  }, [up])

  if (!up) return null

  return (
    <>
      <div className="med-col med-left">
        <MissionStatus />
        <CrewHealth />
        <AgentTools />
      </div>
      <div className="med-col med-right">
        <Cardio />
        <Anatomy />
        <CameraAssess />
      </div>
      {/* The guided camera check takes the centre while it runs. */}
      <CameraStage />
      {/* The guided health check (Step 27): one workflow, in the centre. */}
      <HealthCheck />
    </>
  )
}
