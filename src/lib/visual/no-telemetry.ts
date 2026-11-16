/**
 * Keep MediaPipe's usage logging on this machine.
 *
 * @mediapipe/tasks-vision (1.0.1) creates a usage logger for every task it
 * builds — Face Landmarker and Hand Landmarker alike — and POSTs protobuf
 * usage reports to Google every minute and on close
 * (https://odml.pa.googleapis.com/v1/log). It carries no images, but it is
 * still the camera stack talking to a server, there is no option to turn it
 * off, and the page's CSP cannot single it out (connect-src allows https: for
 * model downloads). Found by the offline test for the camera assessment, which
 * blocks every outside request and saw this one attempted.
 *
 * So the page's fetch refuses that one endpoint. The logger treats a failed
 * send as fatal and stops its own timer, so after the first refusal it goes
 * quiet for the life of the task. Nothing else is affected.
 */

const BLOCKED = /^https:\/\/odml\.pa\.googleapis\.com\//

let installed = false

export function blockMediaPipeTelemetry(): void {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  installed = true
  const real = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (BLOCKED.test(url)) return Promise.reject(new TypeError('MediaPipe usage logging is disabled in MeBo'))
    return real(input, init)
  }
}
