/**
 * MeBo's two medical agent workflows, as LLM-independent orchestration.
 *
 *   identify → begin → (ask questions) → assess → explain → remember
 *
 * Cardiovascular: an astronaut reports dizziness or an unusual heart symptom.
 * Sleep and fatigue: an astronaut reports poor sleep or exhaustion.
 *
 * A model drives the conversation; these functions supply everything it may
 * use, from the right places: measurements only from SQLite, history only
 * from this astronaut's memory file, questions only from the fixed question
 * set, findings only from the rules, guidance only from the NASA/CSA library.
 * Nothing here invents a measurement, a threshold, a diagnosis or an
 * instruction, and nothing here lets memory change a rule's decision.
 */

import { MedicalError } from './service.mjs'
import { createMemoryStore, MEMORY_NOTICE } from './memory/store.mjs'
import { assess, questions, WORKFLOWS } from './cds/index.mjs'
import { knowledgeBase } from './knowledge/search.mjs'
import { describe, validateObservation, VISUAL_NOTICE } from './vision/observations.mjs'
import { AUTHORITY, LIMITATIONS, contextStatements, explain, followUps } from './vision/alertness.mjs'
import { classifyFatigueConcern, REFERENCES as CONCERN_REFERENCES } from './vision/fatigue-concern.mjs'

// --- memory, one store per service ------------------------------------------------

const stores = new WeakMap()

/** The memory store for this service, created on first use. */
export function memoryOf(service) {
  if (!stores.has(service)) {
    stores.set(
      service,
      createMemoryStore({
        ...(service.memoryDir ? { dir: service.memoryDir } : {}),
        crewIds: () => service.crew().crew.map((c) => c.id),
        now: service.clock ?? Date.now,
        ...(service.onMemorySave ? { onSave: service.onMemorySave } : {}),
      }),
    )
  }
  return stores.get(service)
}

// --- identify -----------------------------------------------------------------------

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

/** How a role is said out loud. Mission specialist is shared, so it is not a key. */
const ROLE_WORDS = { CDR: 'commander', PLT: 'pilot' }

/**
 * Who is speaking? Matches a callsign, role or surname. Never guesses: an
 * unknown or ambiguous name returns found: false with the candidates.
 */
export function identify(service, name) {
  const crew = service.crew().crew
  const words = new Set(norm(name).split(' '))
  const hits = crew.filter((c) => {
    // Callsign, id, role and its spoken form, and display-name words of three
    // letters or more — so an initial ("A.") or "fictional" never matches.
    const keys = [c.id, c.callsign, c.role, ROLE_WORDS[c.role], ...norm(c.display_name).split(' ')]
      .map(norm)
      .filter((k) => k && k.length >= 3 && k !== 'fictional')
    return keys.some((k) => words.has(k))
  })
  if (hits.length === 1) return { found: true, crew: hits[0] }
  return {
    found: false,
    message: hits.length ? 'More than one crew member matches; ask which one.' : 'No crew member matches; ask for their name or role.',
    candidates: (hits.length ? hits : crew).map((c) => ({ id: c.id, callsign: c.callsign, role: c.role })),
  }
}

// --- route ----------------------------------------------------------------------------

/**
 * Which workflow a complaint belongs to. Fixed keywords (prototype), so the
 * routing is the same whichever model hears the complaint. Both or neither →
 * null, and the model asks.
 */
export const ROUTES = {
  cardiovascular: ['dizzy', 'dizziness', 'lightheaded', 'light headed', 'faint', 'fainted', 'palpitation', 'palpitations',
    'heart racing', 'racing heart', 'pounding', 'heartbeat', 'heart rate', 'chest', 'blood pressure', 'heart'],
  sleep_fatigue: ['sleep', 'slept', 'sleeping', 'insomnia', 'tired', 'exhausted', 'exhaustion', 'fatigue', 'fatigued',
    'drowsy', 'sleepy', 'cannot rest', 'worn out'],
}

export function route(text) {
  const t = ` ${norm(text)} `
  const matched = Object.fromEntries(
    Object.entries(ROUTES).map(([wf, words]) => [wf, words.filter((w) => t.includes(` ${w} `))]),
  )
  const candidates = Object.keys(matched).filter((wf) => matched[wf].length)
  return { workflow: candidates.length === 1 ? candidates[0] : null, candidates, matched }
}

// --- begin -------------------------------------------------------------------------------

/** Recent history for the workflow's indicators — from SQLite, nowhere else. */
function recentHistory(service, crewId, metrics) {
  const summary = service.summary(crewId).metrics
  return Object.fromEntries(
    metrics.map((code) => {
      const s = summary[code]
      const week = service.trend(crewId, code, { days: 7 }).trend
      const fortnight = service.trend(crewId, code, { days: 14 }).trend
      return [
        code,
        {
          name: s.name,
          unit: s.unit,
          latest: s.latest && { value: s.latest.value, observed_at: s.latest.observed_at, stale: s.latest.stale, observation_id: s.latest.observation_id },
          baseline_mean: s.baseline?.mean ?? null,
          mean_7_days: week.mean,
          days_with_data_7: week.days_with_data,
          slope_per_week_14_days: fortnight.slope_per_week,
        },
      ]
    }),
  )
}

/** The questions still to ask, and the ones memory already answers. */
function pendingQuestions(service, crewId, workflowId) {
  const all = questions(service, crewId, workflowId)
  const remembered = memoryOf(service).validAnswers(crewId, workflowId)
  return {
    instructions: all.instructions,
    questions_to_ask: all.questions.filter((q) => !(q.id in remembered)),
    already_answered: Object.fromEntries(
      all.questions.filter((q) => q.id in remembered).map((q) => [q.id, { question: q.text, ...remembered[q.id] }]),
    ),
  }
}

/**
 * Start a check: everything the model needs before asking a single question.
 * Records the reported symptom in this astronaut's memory.
 */
export function beginCheck(service, { crew_id, workflow, reported_symptom }) {
  const crew = service.summary(crew_id).astronaut // 404 for an unknown id
  const routed = !workflow && reported_symptom ? route(reported_symptom) : null
  const wfId = workflow ?? routed?.workflow ?? null
  const memory = memoryOf(service)
  if (reported_symptom) memory.recordSymptom(crew_id, reported_symptom, { workflow: wfId })
  const mem = memory.summary(crew_id)

  if (!wfId) {
    return {
      crew: { id: crew.id, callsign: crew.callsign, role: crew.role },
      workflow: null,
      routing: routed,
      message: 'Which check is this — cardiovascular or sleep and fatigue? Ask the crew member.',
      memory: { open_concerns: mem.open_concerns, follow_up_prompts: mem.follow_up_prompts },
    }
  }
  const w = WORKFLOWS[wfId]
  if (!w) throw new MedicalError(404, `No workflow "${wfId}". Known: ${Object.keys(WORKFLOWS).join(', ')}.`)

  let guidance = []
  try {
    const kb = knowledgeBase()
    guidance = w.background.map((b) => ({ ...kb.passage(b.passage), relevance: b.why })).filter((p) => p.passage_id)
  } catch {
    // The knowledge base is optional context; the check goes on without it.
  }

  return {
    simulated: true,
    notice: `${MEMORY_NOTICE} Measurements are synthetic demonstration data.`,
    crew: { id: crew.id, callsign: crew.callsign, role: crew.role },
    workflow: { id: w.id, title: w.title },
    routing: routed,
    recent_history: { source: 'medical database (SQLite)', metrics: recentHistory(service, crew_id, w.metrics) },
    memory: {
      open_concerns: mem.open_concerns.filter((c) => c.workflow === w.id),
      follow_up_prompts: mem.follow_up_prompts.filter((f) => f.workflow === w.id),
      recent_symptoms: mem.recent_symptoms.slice(-5),
      last_assessment: [...mem.recent_assessments].reverse().find((a) => a.workflow === w.id) ?? null,
    },
    ...pendingQuestions(service, crew_id, w.id),
    nasa_guidance: guidance,
    supplementary_observations: visualContext(service, crew_id),
    next_step:
      `Ask questions_to_ask one at a time, in their exact wording. Then call assess_${w.id} with crew_id ` +
      `"${crew.id}" and the answers. Answers in already_answered are applied automatically — do not ask them again.`,
  }
}

// --- assess --------------------------------------------------------------------------------

/**
 * Run the assessment with the astronaut's answers, plus any remembered
 * answers still inside their windows (explicit answers win), and file the
 * result in memory. Memory supplies only answers the astronaut gave; the
 * rules alone decide the result, and the result is what memory records.
 */
export function runAssessment(service, crewId, workflowId, answers = {}, { useRemembered = true } = {}) {
  const memory = memoryOf(service)
  const remembered = useRemembered ? memory.validAnswers(crewId, workflowId) : {}
  const reused = Object.fromEntries(Object.entries(remembered).filter(([q]) => answers[q] === undefined))
  const merged = { ...Object.fromEntries(Object.entries(reused).map(([q, a]) => [q, a.value])), ...answers }
  const result = assess(service, crewId, workflowId, merged)
  const filed = memory.recordAssessment(crewId, result, { explicitAnswers: answers })
  return {
    ...result,
    answers_from_memory: reused,
    memory: { ...filed, notice: 'Recorded in this crew member\'s memory. Memory never changes the result above.' },
  }
}

// --- camera observations (Step 26) -----------------------------------------------------------

/** A camera observation older than this is not offered as context for a new check. */
const VISUAL_RECENT_MS = 60 * 60_000

/**
 * File a camera observation from the guided check: validated to a fixed
 * numeric shape, then stored in this crew member's memory. It is never passed
 * to the rules engine.
 */
export function recordVisualObservation(service, crewId, observation) {
  service.summary(crewId) // 404 for an unknown crew member
  const clean = validateObservation(observation)
  const entry = memoryOf(service).recordObservation(crewId, clean)
  // What MeBo says next: the explanation, and suggested next steps in the
  // light of the crew member's records. Composed, not stored.
  const summary = alertnessSummary(service, crewId)
  return { ...entry, description: describe(clean), explanation: explain(clean), follow_up: summary.follow_up }
}

/**
 * The observational alertness summary (Step 26B): the latest camera measures
 * beside recorded sleep, self-rated tiredness, the last sleep and fatigue
 * assessment and mission context, with explanations and suggested next steps.
 * Read-only and supplementary: it sets no level and judges nothing, and the
 * rules engine stays authoritative (medical/vision/alertness.mjs).
 */
export function alertnessSummary(service, crewId) {
  const record = service.summary(crewId)
  const crew = record.astronaut
  const memory = memoryOf(service)
  const clock = service.clock ?? Date.now
  const nowMs = clock()

  const last = memory.observations(crewId, 5).reverse().find((e) => e.observation.alertness !== undefined) ?? null
  const observation = last?.observation ?? null
  const observationAgeMin = last ? (nowMs - Date.parse(last.at)) / 60000 : null

  const sleep = recentHistory(service, crewId, ['sleep_duration']).sleep_duration
  const answers = memory.lastAnswers(crewId, 'sleep_fatigue')
  const pick = (q) => (answers[q] ? { value: answers[q].value, age_minutes: answers[q].age_minutes, at: answers[q].at } : null)
  const selfReport = { fatigue: pick('fatigue'), dozed_on_task: pick('dozed_on_task') }
  const mem = memory.summary(crewId)
  const lastAssessment = [...mem.recent_assessments].reverse().find((x) => x.workflow === 'sleep_fatigue') ?? null
  const openConcerns = mem.open_concerns.filter((c) => c.workflow === 'sleep_fatigue')
  const mission = {
    name: service.mission().mission.name,
    mission_day: record.metrics.sleep_duration?.latest?.mission_day ?? null,
    scenario_now: record.scenario_now ?? null,
  }

  let background = []
  try {
    const kb = knowledgeBase()
    background = ['S2:risk-of-inadequate-sleep-and-irregular-schedules', 'S2:risk-of-behavioral-changes-and-psychiatric-disor']
      .map((id) => kb.passage(id))
      .filter((p) => p?.passage_id)
  } catch {
    // The library is optional context.
  }

  return {
    simulated: true,
    crew: { id: crew.id, callsign: crew.callsign },
    notice: VISUAL_NOTICE,
    authority: AUTHORITY,
    affects_assessment: false,
    camera: last
      ? {
          observation_id: last.observation_id,
          at: last.at,
          age_minutes: Math.round(observationAgeMin),
          alertness: observation.alertness ?? null,
          explanation: explain(observation),
        }
      : null,
    sleep_history: { source: 'medical database (SQLite), synthetic', ...sleep },
    self_report: selfReport,
    last_rule_assessment: lastAssessment && {
      level: lastAssessment.level, status: lastAssessment.status, at: lastAssessment.at,
      summary: lastAssessment.summary, assessment_id: lastAssessment.assessment_id,
    },
    open_concerns: openConcerns.map((c) => ({ title: c.title, level: c.level, opened_at: c.opened_at })),
    mission,
    context: contextStatements({ observation, observationAgeMin, sleep, selfReport, lastAssessment, mission }),
    follow_up: followUps({ observation, selfReport, lastAssessment, openConcerns, nowMs }),
    nasa_background: background,
    limitations: LIMITATIONS,
  }
}

/**
 * The camera-supported fatigue concern (Step 26D): the sleep and fatigue
 * assessment (rules engine, unchanged) as a floor, sleep history and
 * self-report as context, and the camera's PERCLOS and sustained closures
 * only when reliable — classified low, moderate, high or indeterminate by
 * medical/vision/fatigue-concern.mjs, then filed in this crew member's memory
 * with its evidence, provenance and references.
 *
 * Uses the given assessment, or the latest sleep_fatigue assessment in
 * memory, and the latest camera observation (set aside when older than the
 * classification allows). Never runs or changes an assessment.
 */
export function assessFatigueConcern(service, crewId, { assessment_id, observation_id } = {}) {
  const record = service.summary(crewId) // 404 for an unknown crew member
  const memory = memoryOf(service)
  const clock = service.clock ?? Date.now
  const nowMs = clock()

  const assessments = memory.summary(crewId).recent_assessments.filter((a) => a.workflow === 'sleep_fatigue')
  const assessment = assessment_id ? assessments.find((a) => a.assessment_id === assessment_id) : assessments.at(-1)
  if (assessment_id && !assessment) throw new MedicalError(404, `No recent sleep and fatigue assessment "${assessment_id}" for ${crewId}.`)

  // The camera observation: the one named (the check that just ran), none
  // ("none": this check had no camera), or by default the latest.
  let last
  if (observation_id === 'none') last = null
  else if (observation_id) {
    last = memory.observations(crewId, 200).find((e) => e.observation_id === observation_id) ?? null
    if (!last) throw new MedicalError(404, `No camera observation "${observation_id}" for ${crewId}.`)
  } else last = memory.observations(crewId, 5).reverse()[0] ?? null
  const sleep = recentHistory(service, crewId, ['sleep_duration']).sleep_duration
  const answers = memory.lastAnswers(crewId, 'sleep_fatigue')
  const pick = (q) => (answers[q] ? { value: answers[q].value, age_minutes: answers[q].age_minutes } : null)

  const concern = classifyFatigueConcern({
    assessment: assessment ?? null,
    observation: last?.observation ?? null,
    observationId: last?.observation_id ?? null,
    observationAt: last?.at ?? null,
    observationAgeMin: last ? (nowMs - Date.parse(last.at)) / 60000 : null,
    sleep,
    selfReport: { fatigue: pick('fatigue'), dozed_on_task: pick('dozed_on_task') },
  })

  // The NASA reference, verbatim from the library where it is available.
  let references = concern.references
  try {
    const kb = knowledgeBase()
    references = CONCERN_REFERENCES.map((r) => {
      const p = r.passage_id ? kb.passage(r.passage_id) : null
      return p?.passage_id ? { ...r, citation: p.citation, url: p.url, retrieved_at: p.retrieved_at } : r
    })
  } catch {
    // The library is optional context.
  }

  const filed = memory.recordFatigueConcern(crewId, {
    ...concern,
    references,
    provenance: {
      method: concern.method,
      computed_at: new Date(nowMs).toISOString(),
      assessment_id: assessment?.assessment_id ?? null,
      assessment_inputs_sha256: assessment?.inputs_sha256 ?? null,
      dataset_sha256: assessment?.dataset_sha256 ?? null,
      observation_id: last?.observation_id ?? null,
      scenario_now: record.scenario_now ?? null,
    },
  })
  return {
    ...filed,
    crew: { id: record.astronaut.id, callsign: record.astronaut.callsign },
    notice:
      "A prototype classification beside the rules engine, not part of it. The rules engine's escalation guidance " +
      'applies unchanged; this can only add concern, never reduce it, and it is not a diagnosis or a fitness-for-duty decision.',
  }
}

/** This crew member's latest fatigue concern, or null. Read-only. */
export function latestFatigueConcern(service, crewId) {
  service.summary(crewId)
  return memoryOf(service).fatigueConcerns(crewId, 1)[0] ?? null
}

/**
 * The most recent camera observation across the crew, for the Camera
 * Assessment panel after a reload, with its plain description and spoken
 * explanation rebuilt from the stored numbers. Read-only.
 */
export function latestVisualObservation(service) {
  const e = memoryOf(service).latestObservation()
  if (!e) return null
  const crew = service.crew().crew?.find((c) => c.id === e.astronaut_id)
  return { ...e, callsign: crew?.callsign ?? null, description: describe(e.observation), explanation: explain(e.observation) }
}

/** This crew member's camera observations, newest first, described in plain words. */
export function visualObservations(service, crewId, limit = 3) {
  service.summary(crewId)
  const list = memoryOf(service).observations(crewId, limit).reverse()
  return {
    crew_id: crewId,
    notice: VISUAL_NOTICE,
    affects_assessment: false,
    observations: list.map((e) => ({ ...e, description: describe(e.observation) })),
    found: list.length > 0,
  }
}

/**
 * The latest camera observation, if recent, as supplementary context for a
 * check. Offered beside the questions, never fed into the assessment.
 */
function visualContext(service, crewId) {
  const last = memoryOf(service).observations(crewId, 1)[0]
  const clock = service.clock ?? Date.now
  if (!last || clock() - Date.parse(last.at) > VISUAL_RECENT_MS) {
    return {
      camera_observation: null,
      notice: 'No recent camera observation. One can be offered (request_visual_observation); it is optional and never changes the assessment.',
    }
  }
  return {
    camera_observation: { observation_id: last.observation_id, at: last.at, description: describe(last.observation) },
    notice: VISUAL_NOTICE,
    affects_assessment: false,
  }
}

export { pendingQuestions, recentHistory }
