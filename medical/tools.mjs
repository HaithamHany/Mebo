/**
 * MeBo's medical tools, defined once in a model-neutral form.
 *
 * Each tool is { name, description, input_schema (JSON Schema), run }. That
 * is the shape every tool-calling model uses, so:
 *   - the Claude bridge wraps these as an in-process MCP server
 *     (bridge/medical-tools.mjs);
 *   - the HTTP API lists them at GET /medical/tools and runs them at
 *     POST /medical/tools/<name>, for any other model or agent;
 *   - a future Gemma/Ollama backend can pass `input_schema` straight through
 *     as function definitions.
 *
 * None of them writes to the medical database, and none lets the caller
 * supply a threshold or a rule. Three write only to MeBo's own conversational
 * memory (medical/memory, one JSON file per astronaut): record_crew_memory
 * (an append-only note, length-limited), begin_medical_check (the reported
 * symptom) and the assess_* tools (the result, linked by assessment_id). No
 * tool can delete memory or close a concern — only a later rule-based
 * assessment closes one.
 *
 * Camera observations (Step 26) are read here (get_visual_observations) but
 * written only by the browser's guided check over HTTP, so no model can
 * supply one; and no assessment reads them. assess_fatigue_concern (Step 26D)
 * reads them, with the last sleep and fatigue assessment, into a separate
 * prototype classification filed in memory; it never changes an assessment.
 */

import { WORKFLOWS } from './cds/index.mjs'
import { MedicalError } from './service.mjs'
import {
  alertnessSummary, assessFatigueConcern, beginCheck, identify, memoryOf, pendingQuestions, runAssessment, visualObservations,
} from './workflows.mjs'
import { questions } from './cds/index.mjs'
import { knowledgeBase } from './knowledge/search.mjs'

const CREW_ID = {
  type: 'string',
  description: 'Crew member id: cdr, plt, ms1 or ms2 (see list_crew).',
}

const yesNo = { type: 'string', enum: ['yes', 'no'] }

const CARDIO_ANSWERS = {
  type: 'object',
  description:
    'Answers to the self-assessment questions, exactly as the crew member gave them. Leave out any question not yet asked; the assessment will list it as missing.',
  properties: {
    chest_pain: yesNo,
    short_of_breath: yesNo,
    fainted: yesNo,
    weak_or_lightheaded: yesNo,
    radiating_pain: yesNo,
    palpitations: yesNo,
  },
  additionalProperties: false,
}

const SLEEP_ANSWERS = {
  type: 'object',
  description:
    'Answers to the self-assessment questions, exactly as the crew member gave them. fatigue is 1–5. Leave out any question not yet asked.',
  properties: {
    fatigue: { type: 'integer', minimum: 1, maximum: 5 },
    dozed_on_task: yesNo,
    schedule_shift: yesNo,
    self_harm: yesNo,
  },
  additionalProperties: false,
}

const ASSESS_NOTE =
  'Evaluates fixed, documented rules (published sources and labelled prototype assumptions) against the ' +
  "crew member's recorded data and answers. Returns observations, evidence with references, missing " +
  'measurements, concerns, recommended next assessments and escalation guidance. Relay the escalation ' +
  'guidance as given; do not add thresholds, diagnoses or treatments of your own. Data is synthetic.'

const USE_REMEMBERED = {
  type: 'boolean',
  description:
    'Apply answers this crew member already gave that are still valid (default true), so they are not asked twice.',
}

const MEMORY_NOTE =
  ' Files the result in this crew member\'s memory (linked by assessment_id); memory never changes the result.'

export const TOOLS = [
  {
    name: 'list_crew',
    description: 'List the crew members (fictional, synthetic profiles) with their ids.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: (service) => service.crew(),
  },
  {
    name: 'identify_crew_member',
    description:
      'Work out which crew member is speaking from a name, callsign or role ("Novak", "the pilot"). Returns the id, or found: false with candidates — then ask. Never guess.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'What they said their name or role is.' } },
      required: ['name'],
      additionalProperties: false,
    },
    run: (service, a) => identify(service, a.name),
  },
  {
    name: 'get_crew_health_summary',
    description:
      "One crew member's latest readings, personal baselines and deviation from baseline for every recorded indicator. Descriptive only.",
    input_schema: { type: 'object', properties: { crew_id: CREW_ID }, required: ['crew_id'], additionalProperties: false },
    run: (service, a) => service.summary(a.crew_id),
  },
  {
    name: 'get_crew_memory',
    description:
      "This crew member's conversational memory: open concerns from earlier assessments, follow-up prompts to raise, " +
      'recent reported symptoms and conversations, recent assessments, and answers still valid. Call it when you ' +
      'know who you are talking to. Not the medical record, and it never changes an assessment.',
    input_schema: { type: 'object', properties: { crew_id: CREW_ID }, required: ['crew_id'], additionalProperties: false },
    run: (service, a) => memoryOf(service).summary(a.crew_id),
  },
  {
    name: 'begin_medical_check',
    description:
      'Start a check when a crew member reports a symptom (dizziness, a racing heart, poor sleep, exhaustion…). ' +
      'Returns their recent history from the medical database, relevant memory and follow-ups, the questions still ' +
      'to ask (already-answered ones removed), NASA guidance passages, and the next step. Records the reported ' +
      'symptom. Give workflow if known; otherwise it is routed from reported_symptom, or you are told to ask.',
    input_schema: {
      type: 'object',
      properties: {
        crew_id: CREW_ID,
        workflow: { type: 'string', enum: Object.keys(WORKFLOWS) },
        reported_symptom: { type: 'string', description: 'What they reported, briefly, in their words.' },
      },
      required: ['crew_id'],
      additionalProperties: false,
    },
    run: (service, a) => {
      if (a.reported_symptom !== undefined && (typeof a.reported_symptom !== 'string' || a.reported_symptom.length > 500)) {
        throw new MedicalError(400, 'reported_symptom must be a string of at most 500 characters')
      }
      return beginCheck(service, a)
    },
  },
  {
    name: 'get_self_assessment_questions',
    description:
      'The structured self-assessment questions still to ask this crew member, in order, plus the ones already answered recently. Ask questions_to_ask one at a time using the exact wording, then call the matching assess_* tool with the answers.',
    input_schema: {
      type: 'object',
      properties: { crew_id: CREW_ID, workflow: { type: 'string', enum: Object.keys(WORKFLOWS) } },
      required: ['crew_id', 'workflow'],
      additionalProperties: false,
    },
    run: (service, a) => {
      const base = questions(service, a.crew_id, a.workflow)
      return { ...base, ...pendingQuestions(service, a.crew_id, a.workflow) }
    },
  },
  {
    name: 'assess_cardiovascular',
    description: `Cardiovascular change assessment: heart rate, blood pressure, personal baseline, 14-day trend, reported symptoms and mission context. ${ASSESS_NOTE}${MEMORY_NOTE}`,
    input_schema: {
      type: 'object',
      properties: { crew_id: CREW_ID, answers: CARDIO_ANSWERS, use_remembered_answers: USE_REMEMBERED },
      required: ['crew_id'],
      additionalProperties: false,
    },
    run: (service, a) =>
      runAssessment(service, a.crew_id, 'cardiovascular', a.answers ?? {}, { useRemembered: a.use_remembered_answers !== false }),
  },
  {
    name: 'assess_sleep_fatigue',
    description: `Sleep and fatigue assessment: sleep duration and recent change, self-rated fatigue, falling asleep on task, schedule changes and mood. Includes NASA background on sleep. ${ASSESS_NOTE}${MEMORY_NOTE}`,
    input_schema: {
      type: 'object',
      properties: { crew_id: CREW_ID, answers: SLEEP_ANSWERS, use_remembered_answers: USE_REMEMBERED },
      required: ['crew_id'],
      additionalProperties: false,
    },
    run: (service, a) =>
      runAssessment(service, a.crew_id, 'sleep_fatigue', a.answers ?? {}, { useRemembered: a.use_remembered_answers !== false }),
  },
  {
    name: 'record_crew_memory',
    description:
      "Add a short note to this crew member's memory: a symptom they reported (kind symptom) or a one-line summary " +
      'of the conversation (kind conversation_note). Append-only, at most 500 characters. Never record measurements, ' +
      "diagnoses or another crew member's information.",
    input_schema: {
      type: 'object',
      properties: {
        crew_id: CREW_ID,
        kind: { type: 'string', enum: ['symptom', 'conversation_note'] },
        text: { type: 'string', description: 'The note, at most 500 characters.' },
      },
      required: ['crew_id', 'kind', 'text'],
      additionalProperties: false,
    },
    run: (service, a) => {
      const m = memoryOf(service)
      if (a.kind === 'symptom') return { recorded: m.recordSymptom(a.crew_id, a.text) }
      if (a.kind === 'conversation_note') return { recorded: m.recordConversation(a.crew_id, a.text) }
      throw new MedicalError(400, 'kind must be symptom or conversation_note')
    },
  },
]

TOOLS.push({
  name: 'search_space_medical_knowledge',
  description:
    "Search MeBo's offline library of official NASA and Canadian Space Agency pages on astronaut health: the " +
    'five hazards (radiation, isolation and confinement, distance from Earth, gravity fields, closed ' +
    'environments), NASA\'s human health risks, and current research. Returns verbatim passages with full ' +
    'citations, or found: false when the library does not cover the question — then say so instead of ' +
    'answering from general knowledge. Background information only: it sets no thresholds and never changes an assessment.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The question, in plain words.' },
      max_results: { type: 'integer', minimum: 1, maximum: 5, description: 'How many passages (default 3).' },
      source_ids: {
        type: 'array',
        items: { type: 'string', enum: ['S1', 'S2', 'S3', 'S4', 'S5'] },
        description: 'Restrict to these sources (optional).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  run: (_service, a) => {
    if (typeof a.query !== 'string' || !a.query.trim()) throw new MedicalError(400, 'query must be a non-empty string')
    const limit = a.max_results ?? 3
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new MedicalError(400, 'max_results must be 1 to 5')
    const sourceIds = a.source_ids ?? null
    if (sourceIds && (!Array.isArray(sourceIds) || sourceIds.some((s) => !/^S[1-5]$/.test(s)))) {
      throw new MedicalError(400, 'source_ids must be a list of S1–S5')
    }
    return { simulated: false, ...knowledgeBase().search(a.query, { limit, sourceIds }) }
  },
})

// Camera observations (Step 26): read-only for any model. They are written
// only by the browser's guided camera check, as a validated numeric summary
// (POST /medical/visual-observations) — never by a model, which therefore
// cannot invent one. They never feed an assessment.
TOOLS.push({
  name: 'get_visual_observations',
  description:
    "This crew member's recent camera observations from the guided camera check: face in view, eye opening " +
    '(blinks, unprompted eye closures), head movement and which instructed tasks were completed, each with a ' +
    'plain description. Supplementary and non-diagnostic: say what the camera observed, never infer fatigue, ' +
    'illness or mood from it. It never changes an assessment or an escalation level.',
  input_schema: {
    type: 'object',
    properties: {
      crew_id: CREW_ID,
      limit: { type: 'integer', minimum: 1, maximum: 5, description: 'How many, newest first (default 3).' },
    },
    required: ['crew_id'],
    additionalProperties: false,
  },
  run: (service, a) => {
    const limit = a.limit ?? 3
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new MedicalError(400, 'limit must be 1 to 5')
    return visualObservations(service, a.crew_id, limit)
  },
})

// The observational alertness summary (Step 26B): camera measures beside
// sleep history, self-rated tiredness and the last sleep and fatigue
// assessment. Read-only; sets no level; the rules engine stays authoritative.
TOOLS.push({
  name: 'get_alertness_summary',
  description:
    "An observational summary of this crew member's alertness: the latest camera measures (PERCLOS, blinks, eye " +
    'closures, with measurement quality), recorded sleep history, their own tiredness rating, the last sleep and ' +
    'fatigue assessment, mission context, an explanation in plain words, suggested follow-up questions, and the ' +
    'limitations. It is not an assessment: it sets no level, gives no diagnosis and cannot judge fitness for duty. ' +
    'The sleep and fatigue assessment (assess_sleep_fatigue) decides any escalation.',
  input_schema: { type: 'object', properties: { crew_id: CREW_ID }, required: ['crew_id'], additionalProperties: false },
  run: (service, a) => alertnessSummary(service, a.crew_id),
})

// The camera-supported fatigue concern (Step 26D): a separate classification
// beside the rules engine. Takes no thresholds or measures from the caller.
TOOLS.push({
  name: 'assess_fatigue_concern',
  description:
    'Camera-supported fatigue concern: combines the latest sleep and fatigue assessment (rules engine, unchanged), ' +
    "sleep history, self-report and — only when reliable and recent — the camera's PERCLOS and sustained eye closures " +
    'into low, moderate, high or indeterminate, listing every contributing indicator. Run it after assess_sleep_fatigue. ' +
    "The camera can raise the concern but never lower the rules engine's level; unreliable camera data is set aside, " +
    'never read as normal. A prototype classification, not a diagnosis, not an escalation and not fitness for duty: ' +
    "relay the rules engine's guidance first, then `spoken`. Filed in the crew member's memory with its evidence.",
  input_schema: {
    type: 'object',
    properties: {
      crew_id: CREW_ID,
      assessment_id: { type: 'string', description: 'The sleep and fatigue assessment to build on; defaults to the latest.' },
      observation_id: {
        type: 'string',
        description: 'The camera observation from this check, or "none" when this check had no camera; defaults to the latest recent one.',
      },
    },
    required: ['crew_id'],
    additionalProperties: false,
  },
  run: (service, a) => assessFatigueConcern(service, a.crew_id, { assessment_id: a.assessment_id, observation_id: a.observation_id }),
})

export const TOOL = Object.fromEntries(TOOLS.map((t) => [t.name, t]))

/**
 * Run a tool by name. The one entry point every adapter uses, so argument
 * checking is identical whichever model, or no model, is calling.
 */
export function callTool(service, name, args = {}) {
  const t = TOOL[name]
  if (!t) throw new MedicalError(404, `No medical tool "${name}". Known: ${TOOLS.map((x) => x.name).join(', ')}.`)
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new MedicalError(400, 'arguments must be an object')
  const schema = t.input_schema
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) throw new MedicalError(400, `${name} has no argument "${key}"`)
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw new MedicalError(400, `${name} needs "${key}"`)
    }
  }
  return t.run(service, args)
}

/** Tool definitions without handlers, for listing to a model. */
export const toolDefinitions = () =>
  TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }))
