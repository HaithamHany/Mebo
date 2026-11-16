import { useEffect, useRef } from 'react'
import { cameraStream } from '../../lib/camera'
import { latestLandmarks } from '../../lib/visual/face'

/** The landmarks drawn on the preview: eye corners and lids, nose tip, cheeks. */
const SHOWN = [33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380, 1, 234, 454]

/**
 * The live picture, mirrored the way a person expects to see themselves, with
 * the tracked points over it. Drawn straight from the shared camera stream;
 * nothing is captured or kept. Used by the side card and the centre view.
 */
export function CameraPreview({ dot = 1.6 }: { dot?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    const video = videoRef.current
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      const stream = cameraStream()
      if (!video || !canvas) return
      if (stream && video.srcObject !== stream) {
        video.srcObject = stream
        void video.play().catch(() => {})
      }
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, w, h)
      const lm = latestLandmarks
      if (!lm || !video.videoWidth) return
      // Same geometry as object-fit: cover, then mirrored.
      const scale = Math.max(w / video.videoWidth, h / video.videoHeight)
      const vw = video.videoWidth * scale
      const vh = video.videoHeight * scale
      const ox = (w - vw) / 2
      const oy = (h - vh) / 2
      ctx.fillStyle = 'rgba(120, 255, 190, 0.9)'
      for (const i of SHOWN) {
        const p = lm[i]
        if (!p) continue
        ctx.beginPath()
        ctx.arc(w - (ox + p.x * vw), oy + p.y * vh, dot, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      if (video) video.srcObject = null
    }
  }, [dot])

  return (
    <>
      <video ref={videoRef} className="cam-video" muted playsInline />
      <canvas ref={canvasRef} className="cam-overlay" />
    </>
  )
}
