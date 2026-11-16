import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { Card } from './Card'
import { liveHeartRate } from './telemetry'

/**
 * Placeholder for the interactive anatomy viewer.
 *
 * A wireframe figure assembled from primitives, turning slowly, with a heart
 * that beats at the selected crew member's (simulated) rate. It is a stand-in
 * for a proper anatomical model and its region picking — the system chips
 * below are where that interaction will hang, and they are disabled until it
 * exists.
 *
 * Its own small Canvas rather than a corner of the main scene: the main scene
 * is post-processed for bloom and chromatic aberration, which would smear a
 * line drawing this size into mush.
 */

type Part = {
  kind: 'sphere' | 'capsule'
  pos: [number, number, number]
  rot?: [number, number, number]
  /** sphere: radius. capsule: [radius, length]. */
  size: number | [number, number]
}

const BODY: Part[] = [
  { kind: 'sphere', pos: [0, 1.55, 0], size: 0.24 },
  { kind: 'capsule', pos: [0, 0.78, 0], size: [0.34, 0.62] },
  { kind: 'capsule', pos: [0, 0.12, 0], size: [0.27, 0.22] },
  { kind: 'capsule', pos: [-0.52, 0.86, 0], rot: [0, 0, 0.18], size: [0.09, 0.62] },
  { kind: 'capsule', pos: [0.52, 0.86, 0], rot: [0, 0, -0.18], size: [0.09, 0.62] },
  { kind: 'capsule', pos: [-0.62, 0.18, 0], rot: [0, 0, 0.08], size: [0.075, 0.52] },
  { kind: 'capsule', pos: [0.62, 0.18, 0], rot: [0, 0, -0.08], size: [0.075, 0.52] },
  { kind: 'capsule', pos: [-0.17, -0.55, 0], size: [0.12, 0.72] },
  { kind: 'capsule', pos: [0.17, -0.55, 0], size: [0.12, 0.72] },
  { kind: 'capsule', pos: [-0.18, -1.38, 0], size: [0.09, 0.68] },
  { kind: 'capsule', pos: [0.18, -1.38, 0], size: [0.09, 0.68] },
]

function Figure() {
  const group = useRef<THREE.Group>(null)
  const heart = useRef<THREE.Mesh>(null)
  const beat = useRef(0)

  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += dt * 0.35
    // No current reading, no pulse: the heart rests rather than beating at a
    // rate nobody measured.
    const hr = liveHeartRate()
    if (!hr) {
      if (heart.current) heart.current.scale.setScalar(1)
      return
    }
    beat.current = (beat.current + (dt * hr) / 60) % 1
    // A sharp double thump — lub, dub — then rest.
    const b = beat.current
    const pulse = Math.exp(-((b - 0.05) ** 2) / 0.002) + 0.6 * Math.exp(-((b - 0.22) ** 2) / 0.002)
    if (heart.current) heart.current.scale.setScalar(1 + pulse * 0.35)
  })

  return (
    <group ref={group} position={[0, 0.05, 0]}>
      {BODY.map((p, i) => (
        <mesh key={i} position={p.pos} rotation={p.rot ?? [0, 0, 0]}>
          {p.kind === 'sphere' ? (
            <sphereGeometry args={[p.size as number, 14, 10]} />
          ) : (
            <capsuleGeometry args={[(p.size as [number, number])[0], (p.size as [number, number])[1], 4, 10]} />
          )}
          <meshBasicMaterial color="#8fd8ff" wireframe transparent opacity={0.32} />
        </mesh>
      ))}
      <mesh ref={heart} position={[0.08, 0.95, 0.16]}>
        <sphereGeometry args={[0.085, 16, 12]} />
        <meshBasicMaterial color="#ff5d73" />
      </mesh>
    </group>
  )
}

const SYSTEMS = ['Cardiac', 'Pulmonary', 'Musculoskeletal', 'Neuro', 'Vestibular']

export function Anatomy() {
  return (
    <Card title="Interactive Anatomy" code="ANT-01" state="planned" delay={0.2} className="anatomy">
      <div className="anatomy-view">
        <Canvas
          camera={{ position: [0, 0, 4.6], fov: 40 }}
          gl={{ antialias: true, alpha: true }}
          dpr={[1, 2]}
        >
          <Figure />
        </Canvas>
        <span className="anatomy-tag">PREVIEW MODEL</span>
      </div>
      <div className="chips">
        {SYSTEMS.map((s) => (
          <button key={s} className="chip" disabled title="Region selection — coming soon">
            {s}
          </button>
        ))}
      </div>
    </Card>
  )
}
