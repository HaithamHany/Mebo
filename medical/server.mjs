/**
 * The medical data service on its own — no bridge, no Claude, no network
 * beyond loopback.
 *
 *   npm run medical:serve            http://127.0.0.1:8788/medical
 *   MEBO_MEDICAL_PORT=9000 npm run medical:serve
 *
 * The dashboard normally reaches the same API through the bridge. This exists
 * so the medical layer can run, be tested, and be called by a future offline
 * model (e.g. Gemma through Ollama) with the Claude bridge absent entirely.
 *
 * Loopback only, and the Host header is checked, so a web page cannot use
 * DNS rebinding to read the data through this port.
 */

import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { createMedicalService } from './service.mjs'
import { handle, PREFIX } from './http.mjs'

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

export function createMedicalServer(opts = {}) {
  let service = null
  const getService = async () => (service ??= await createMedicalService(opts))
  const server = http.createServer((req, res) => {
    if (!LOCAL.test(req.headers.host ?? '')) {
      res.writeHead(403)
      return res.end('forbidden')
    }
    const origin = req.headers.origin
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      res.writeHead(403)
      return res.end('forbidden')
    }
    const cors = origin
      ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type', vary: 'origin' }
      : {}
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    if (!(req.url ?? '').startsWith(PREFIX)) {
      res.writeHead(404, cors)
      return res.end()
    }
    void handle(getService, req, res, cors)
  })
  server.on('close', () => service?.close())
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MEBO_MEDICAL_PORT ?? 8788)
  createMedicalServer().listen(port, '127.0.0.1', function () {
    console.log(`[medical] serving http://127.0.0.1:${this.address().port}${PREFIX} (synthetic demonstration data)`)
  })
}
