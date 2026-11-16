/**
 * The medical data service over HTTP: a small read-only JSON API.
 *
 * Mounted by the existing bridge (bridge/server.mjs), which applies its own
 * host and origin checks first, and by medical/server.mjs for running the
 * service with no bridge — and therefore no Claude — at all. Either way the
 * handler is the same, and it never calls a language model.
 *
 *   GET /medical                          index of endpoints
 *   GET /medical/provenance               versions, seed, checksum, scenario, references
 *   GET /medical/mission                  mission context
 *   GET /medical/metrics                  indicator catalogue + NASA risk mapping
 *   GET /medical/crew                     crew profiles
 *   GET /medical/crew/:id                 latest values, baselines, deviations
 *   GET /medical/crew/:id/history?metric=heart_rate[&days=30]
 *   GET /medical/crew/:id/trend?metric=heart_rate[&days=30]
 *   GET /medical/dashboard[?days=30&metric=heart_rate]
 *
 * Clinical decision support (Step 20):
 *   GET  /medical/crew/:id/assessments/:workflow/questions
 *   GET  /medical/crew/:id/assessments/:workflow?chest_pain=no&…   (answers as query)
 *   GET  /medical/tools                   tool definitions (JSON Schema), for any model
 *   POST /medical/tools/:name             run one tool with a JSON body of arguments
 *
 * NASA/CSA knowledge (Step 22):
 *   GET  /medical/knowledge/search?q=…[&limit=3&sources=S1,S2]
 *   GET  /medical/knowledge/sources       the snapshot: URLs, titles, dates, hashes
 *
 * Conversational memory (Step 23), read-only here:
 *   GET  /medical/memory                  latest assessment per workflow, all crew
 *   GET  /medical/memory/:id              one astronaut's memory summary
 * Memory is written only by the validated tools, and only to MeBo's own
 * memory files — never to the medical database.
 *
 * Camera observations (Step 26):
 *   POST /medical/visual-observations     {crew_id, observation} from the
 *                                         browser's guided camera check
 *   GET  /medical/crew/:id/visual-observations
 * The observation is a fixed numeric summary (medical/vision/observations.mjs
 * rejects anything else), kept in memory, and read by no assessment.
 *   GET  /medical/crew/:id/fatigue-concern
 * The latest camera-supported fatigue concern (Step 26D), filed by the
 * assess_fatigue_concern tool: a separate classification that never changes
 * an assessment.
 *
 * Nothing a page or a model can reach writes health data: the medical
 * database is read-only from here. POST is accepted only for /medical/tools;
 * the only writes any tool makes are append-only entries in MeBo's own
 * conversational memory (see medical/tools.mjs).
 */

import { MedicalError } from './service.mjs'
import { assess, questions } from './cds/index.mjs'
import { callTool, toolDefinitions } from './tools.mjs'
import { knowledgeBase } from './knowledge/search.mjs'
import {
  alertnessSummary, latestFatigueConcern, latestVisualObservation, memoryOf, recordVisualObservation, visualObservations,
} from './workflows.mjs'

/** Largest JSON body accepted by POST /medical/tools. */
const MAX_BODY = 16 * 1024

export const PREFIX = '/medical'

const ENDPOINTS = [
  'GET /medical/provenance',
  'GET /medical/mission',
  'GET /medical/metrics',
  'GET /medical/crew',
  'GET /medical/crew/:id',
  'GET /medical/crew/:id/history?metric=<code>[&days=<n>]',
  'GET /medical/crew/:id/trend?metric=<code>[&days=<n>]',
  'GET /medical/dashboard[?days=<n>&metric=<code>]',
  'GET /medical/crew/:id/assessments/:workflow/questions',
  'GET /medical/crew/:id/assessments/:workflow[?<question>=<answer>…]',
  'GET /medical/tools',
  'POST /medical/tools/:name  {arguments}',
  'GET /medical/knowledge/search?q=<question>[&limit=<1-5>&sources=S1,S2]',
  'GET /medical/knowledge/sources',
  'GET /medical/memory                      latest assessment per workflow (all crew)',
  'GET /medical/memory/:id                  one crew member\'s conversational memory',
  'POST /medical/visual-observations  {crew_id, observation}   camera check summary (numbers only)',
  'GET /medical/visual-observations         the most recent camera check, across the crew',
  'GET /medical/crew/:id/visual-observations',
  'GET /medical/crew/:id/alertness           observational alertness summary (sets no level)',
  'GET /medical/crew/:id/fatigue-concern     latest camera-supported fatigue concern (prototype; never lowers the rules)',
]

function daysParam(q) {
  const raw = q.get('days')
  if (raw === null) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new MedicalError(400, 'days must be an integer from 1 to 1000')
  return n
}

function metricParam(q, fallback) {
  const m = q.get('metric') ?? fallback
  if (!m) throw new MedicalError(400, 'metric is required')
  return m
}

/** Route one request. `service` is the object from createMedicalService. */
export function route(service, method, rawUrl, body) {
  const url = new URL(rawUrl, 'http://x')
  const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean) // ['medical', ...]
  const q = url.searchParams
  const [, a, id, b, c, d] = parts

  // Tools: the only path that takes POST, and none of its tools writes.
  if (a === 'tools' && parts.length === 3 && method === 'POST') {
    return callTool(service, decodeURIComponent(id), body ?? {})
  }
  // Camera observations (Step 26): the browser's guided check files its
  // numeric summary here. Validated to a fixed shape; stored in memory only.
  if (a === 'visual-observations' && parts.length === 2 && method === 'POST') {
    const b = body ?? {}
    if (typeof b.crew_id !== 'string') throw new MedicalError(400, 'crew_id is required')
    return { recorded: recordVisualObservation(service, b.crew_id, b.observation) }
  }
  if (method !== 'GET') throw new MedicalError(405, 'The medical API is read-only.')
  // The most recent camera check across the crew, for the panel after a reload.
  if (a === 'visual-observations' && parts.length === 2) return { latest: latestVisualObservation(service) }
  if (a === 'tools' && parts.length === 2) return { simulated: true, tools: toolDefinitions() }

  // Conversational memory (Step 23). Reads here; writes only through the
  // validated tools (POST /medical/tools/record_crew_memory, assess_*).
  if (a === 'memory' && parts.length === 2) return { latest: memoryOf(service).latest() }
  if (a === 'memory' && id && parts.length === 3) return memoryOf(service).summary(decodeURIComponent(id))

  // NASA/CSA knowledge (Step 22). Real agency text, so `simulated: false`.
  if (a === 'knowledge' && id === 'sources' && parts.length === 3) {
    return { simulated: false, sources: knowledgeBase().sources() }
  }
  if (a === 'knowledge' && id === 'search' && parts.length === 3) {
    const sources = q.get('sources')
    return callTool(service, 'search_space_medical_knowledge', {
      query: q.get('q') ?? '',
      ...(q.get('limit') ? { max_results: Number(q.get('limit')) } : {}),
      ...(sources ? { source_ids: sources.split(',') } : {}),
    })
  }

  if (a === 'crew' && id && parts.length === 4 && b === 'visual-observations') {
    return visualObservations(service, decodeURIComponent(id), 5)
  }
  if (a === 'crew' && id && parts.length === 4 && b === 'alertness') {
    return alertnessSummary(service, decodeURIComponent(id))
  }
  if (a === 'crew' && id && parts.length === 4 && b === 'fatigue-concern') {
    return { latest: latestFatigueConcern(service, decodeURIComponent(id)) }
  }

  if (a === 'crew' && id && b === 'assessments' && c) {
    const crewId = decodeURIComponent(id)
    if (parts.length === 6 && d === 'questions') return questions(service, crewId, decodeURIComponent(c))
    if (parts.length === 5) return assess(service, crewId, decodeURIComponent(c), Object.fromEntries(q.entries()))
  }

  if (parts.length === 1) {
    return { service: 'mebo-medical', notice: service.provenance().notice, simulated: true, endpoints: ENDPOINTS }
  }
  if (parts.length === 2 && a === 'provenance') return service.provenance()
  if (parts.length === 2 && a === 'mission') return service.mission()
  if (parts.length === 2 && a === 'metrics') return service.metrics()
  if (parts.length === 2 && a === 'crew') return service.crew()
  if (parts.length === 2 && a === 'dashboard') {
    return service.dashboard({ trendDays: daysParam(q) ?? 30, trendMetric: metricParam(q, 'heart_rate') })
  }
  if (a === 'crew' && id && parts.length === 3) return service.summary(decodeURIComponent(id))
  if (a === 'crew' && id && parts.length === 4 && b === 'history') {
    return service.history(decodeURIComponent(id), metricParam(q), { days: daysParam(q) })
  }
  if (a === 'crew' && id && parts.length === 4 && b === 'trend') {
    return service.trend(decodeURIComponent(id), metricParam(q), { days: daysParam(q) ?? 30 })
  }
  throw new MedicalError(404, `No medical endpoint ${url.pathname}`)
}

/**
 * Node http adapter. `getService` is async so the database opens on first
 * use; `headers` carries whatever CORS headers the host server decided on.
 */
export async function handle(getService, req, res, headers = {}) {
  const send = (status, body) => {
    res.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  let service
  try {
    service = await getService()
  } catch (err) {
    return send(503, { error: `Medical data service unavailable: ${err.message}` })
  }
  try {
    let body
    if (req.method === 'POST') {
      // Bounded, and JSON only: tool arguments are a small object.
      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > MAX_BODY) throw new MedicalError(413, 'request body too large')
      }
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        throw new MedicalError(400, 'request body must be JSON')
      }
    }
    send(200, route(service, req.method, req.url, body))
  } catch (err) {
    if (err instanceof MedicalError) return send(err.status, { error: err.message })
    console.error('[medical] request failed:', err)
    send(500, { error: 'internal error' })
  }
}
