/**
 * A synthetic MediaPipe face for tests: 478 landmarks, with every point that
 * src/lib/visual/observe.ts reads placed where the Face Mesh topology puts it.
 * Kept outside test/ because `node --test` runs every file under a test
 * directory.
 *
 * Geometry (normalised coordinates, before the 16:9 aspect correction):
 *   - eye corners 0.04 apart horizontally, lids `0.012 × openness` above and
 *     below the eye line, which gives EAR ≈ 0.34 for a fully open eye and 0
 *     for a shut one;
 *   - the nose shifted sideways by `shift × 0.1` turns the head (yaw).
 *
 * @param opts.shift  head turn, in share of the face's half-width
 * @param opts.eye    both eyes' openness, 0 shut .. 1 open
 * @param opts.eyeR   the person's right eye (image left), overrides `eye`
 * @param opts.eyeL   the person's left eye, overrides `eye`
 * @param opts.dx     move the whole face sideways
 */
export function face({ shift = 0, eye = 1, eyeR, eyeL, dx = 0 } = {}) {
  const pts = Array.from({ length: 478 }, () => ({ x: 0.5 + dx, y: 0.5 }))
  const set = (i, x, y) => (pts[i] = { x: x + dx, y })
  set(234, 0.4, 0.5) // cheeks
  set(454, 0.6, 0.5)
  set(1, 0.5 + shift * 0.1, 0.52) // nose
  set(10, 0.5, 0.35) // forehead
  set(152, 0.5, 0.7) // chin

  // The person's right eye (image left): EAR points 33, 160, 158, 133, 153, 144.
  const a = 0.012 * (eyeR ?? eye)
  set(33, 0.44, 0.45)
  set(133, 0.48, 0.45)
  set(160, 0.4533, 0.45 - a)
  set(158, 0.4667, 0.45 - a)
  set(153, 0.4667, 0.45 + a)
  set(144, 0.4533, 0.45 + a)
  set(159, 0.46, 0.45 - a)
  set(145, 0.46, 0.45 + a)

  // The person's left eye: EAR points 362, 385, 387, 263, 373, 380.
  const b = 0.012 * (eyeL ?? eye)
  set(362, 0.52, 0.45)
  set(263, 0.56, 0.45)
  set(385, 0.5333, 0.45 - b)
  set(387, 0.5467, 0.45 - b)
  set(373, 0.5467, 0.45 + b)
  set(380, 0.5333, 0.45 + b)
  set(386, 0.54, 0.45 - b)
  set(374, 0.54, 0.45 + b)
  return pts
}

/**
 * Frames from a list of segments [seconds, faceOptions | null, blendshapes?],
 * at `fps`. `null` is a frame with no face (MediaPipe found none). `extra`
 * is passed to frameFrom (video height for face size, a brightness sample);
 * a function receives the frame's index and time.
 */
export function clip(frameFrom, segments, { fps = 15, t0 = 0, extra = { height: 720 } } = {}) {
  const out = []
  let t = t0
  for (const [seconds, opts, blend] of segments) {
    const n = Math.round(seconds * fps)
    for (let i = 0; i < n; i++) {
      const x = typeof extra === 'function' ? extra(out.length, t) : extra
      out.push(frameFrom(opts === null ? null : face(opts), blend ?? null, t, 16 / 9, x))
      t += 1000 / fps
    }
  }
  return out
}
