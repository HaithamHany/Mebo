/**
 * MeBo's conversational memory: one JSON file per astronaut under
 * memory/crew/<crew-id>.json.
 *
 * What it is: the continuity of a companion — symptoms the astronaut
 * reported, notes on past conversations, the assessments MeBo ran (linked by
 * assessment_id), the answers they gave, and the concerns still open.
 *
 * What it is not: the medical record. Measurements live in SQLite and are
 * only ever read from there. Memory holds no readings of its own.
 *
 * Rules this module enforces:
 *   - Isolation. A file belongs to exactly one astronaut, named by a crew id
 *     that must exist in the medical database; the owner is checked on every
 *     read and every write, and nothing in one file refers to another person.
 *   - Concerns are opened and closed only by the clinical rules. A finding at
 *     level review or above opens one; a later COMPLETE assessment of the same
 *     workflow in which that rule evaluated false closes it. There is no tool
 *     for a model to dismiss a concern by conversation.
 *   - Memory never decides anything clinical. It can supply answers the
 *     astronaut already gave (within each question's validity window) so they
 *     are not asked twice; the rules still make every decision.
 *   - LLM-independent: plain functions over plain JSON files.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { MedicalError } from '../service.mjs'
import { QUESTIONS } from '../cds/questions.mjs'
import { VISUAL_NOTICE } from '../vision/observations.mjs'

export const MEMORY_SCHEMA = 1
export const DEFAULT_MEMORY_DIR =
  process.env.MEBO_MEMORY_DIR ?? fileURLToPath(new URL('../../memory/crew/', import.meta.url))

/** Levels at which a finding becomes an open concern to follow up. */
export const CONCERN_LEVELS = new Set(['review', 'urgent', 'emergency'])

/** Most entries kept per list; the oldest fall off. */
const KEEP = 200
/** Longest free-text note accepted from a caller. */
export const MAX_NOTE = 500

export const MEMORY_NOTICE =
  'Conversational memory, not the medical record: measurements come only from the medical database. ' +
  'Memory never changes an assessment; open concerns are closed only by a later rule-based assessment.'

const nowIso = (now) => new Date(now()).toISOString()
const short = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)

/**
 * @param {{ dir?: string, crewIds: () => string[], now?: () => number, onSave?: (id: string, json: string) => void }} opts
 *   crewIds: the astronauts that exist (from the medical database).
 *   onSave: told after every write, with the file's full contents, so a host
 *     can keep a durable copy (Netlify Blobs on a hosted deploy). It never
 *     affects the write: the local file is already safe when it is called.
 */
export function createMemoryStore({ dir = DEFAULT_MEMORY_DIR, crewIds, now = Date.now, onSave }) {
  const known = (id) => {
    if (typeof id !== 'string' || !crewIds().includes(id)) {
      throw new MedicalError(404, `No astronaut "${id}" — identify the crew member first.`)
    }
    return id
  }
  const fileOf = (id) => join(dir, `${known(id)}.json`)

  function load(id) {
    const f = fileOf(id)
    if (!existsSync(f)) {
      return {
        schema: MEMORY_SCHEMA, astronaut_id: id, created_at: nowIso(now), updated_at: nowIso(now),
        symptoms: [], conversations: [], assessments: [], answers: {}, concerns: [], observations: [], fatigue_concerns: [],
      }
    }
    const m = JSON.parse(readFileSync(f, 'utf8'))
    // A file that names someone else is never read as this person's history.
    if (m.astronaut_id !== id) throw new MedicalError(500, `Memory file for ${id} belongs to ${m.astronaut_id}`)
    // Files written before camera observations existed (Step 26).
    m.observations ??= []
    // ...and before camera-supported fatigue concerns (Step 26D).
    m.fatigue_concerns ??= []
    return m
  }

  function save(m) {
    mkdirSync(dir, { recursive: true })
    m.updated_at = nowIso(now)
    for (const k of ['symptoms', 'conversations', 'assessments', 'concerns', 'observations', 'fatigue_concerns']) m[k] = m[k].slice(-KEEP)
    // Atomic: a crash mid-write leaves the previous file, never half of one.
    const f = fileOf(m.astronaut_id)
    const tmp = `${f}.${process.pid}.tmp`
    const json = JSON.stringify(m, null, 2) + '\n'
    writeFileSync(tmp, json)
    renameSync(tmp, f)
    try {
      onSave?.(m.astronaut_id, json)
    } catch {
      /* the durable copy is the host's concern; the local write succeeded */
    }
  }

  const note = (text) => {
    if (typeof text !== 'string' || !text.trim()) throw new MedicalError(400, 'text must be a non-empty string')
    if (text.length > MAX_NOTE) throw new MedicalError(400, `text must be at most ${MAX_NOTE} characters`)
    return text.trim()
  }

  /** Answers still inside their question's validity window. */
  function validAnswers(m, workflow) {
    const out = {}
    const t = now()
    for (const [q, a] of Object.entries(m.answers[workflow] ?? {})) {
      const minutes = QUESTIONS[q]?.valid_for_minutes ?? 0
      const age = (t - Date.parse(a.at)) / 60000
      if (minutes > 0 && age <= minutes) out[q] = { ...a, age_minutes: Math.round(age) }
    }
    return out
  }

  function followUps(m) {
    const out = []
    for (const c of m.concerns.filter((c) => c.status === 'open')) {
      out.push({
        concern_id: c.id,
        workflow: c.workflow,
        prompt:
          c.kind === 'incomplete'
            ? `The ${c.workflow_title} on ${c.opened_at.slice(0, 10)} was not finished (missing: ${c.text}). Offer to complete it.`
            : `Last ${c.workflow_title.toLowerCase()} on ${c.last_seen_at.slice(0, 10)} found: ${c.title} (${c.level}). Ask how they are now, and offer to repeat the assessment.`,
      })
    }
    return out
  }

  return {
    dir,

    /** Everything MeBo should know before talking to this astronaut. */
    summary(id) {
      const m = load(id)
      return {
        notice: MEMORY_NOTICE,
        astronaut_id: id,
        updated_at: m.updated_at,
        open_concerns: m.concerns.filter((c) => c.status === 'open'),
        follow_up_prompts: followUps(m),
        recent_symptoms: m.symptoms.slice(-10),
        recent_conversations: m.conversations.slice(-5),
        recent_assessments: m.assessments.slice(-5),
        remembered_answers: {
          cardiovascular: validAnswers(m, 'cardiovascular'),
          sleep_fatigue: validAnswers(m, 'sleep_fatigue'),
        },
        recent_visual_observations: m.observations.slice(-3),
        recent_fatigue_concerns: m.fatigue_concerns.slice(-3),
      }
    },

    /**
     * File a camera observation (Step 26), already validated by
     * medical/vision/observations.mjs. Supplementary: nothing here touches
     * concerns or answers, and no assessment reads it.
     */
    recordObservation(id, observation) {
      const m = load(id)
      const at = nowIso(now)
      const entry = {
        observation_id: `vis-${short(id + at + JSON.stringify(observation))}`,
        astronaut_id: id,
        at,
        source: 'camera_check',
        observation,
        notice: VISUAL_NOTICE,
        affects_assessment: false,
      }
      m.observations.push(entry)
      save(m)
      return entry
    },

    /**
     * File a camera-supported fatigue concern (Step 26D), with its evidence,
     * provenance and references, as classified by
     * medical/vision/fatigue-concern.mjs. A record of a classification:
     * nothing here opens or closes a concern, and no rule reads it.
     */
    recordFatigueConcern(id, concern) {
      const m = load(id)
      const at = nowIso(now)
      const entry = {
        concern_id: `fc-${short(id + at + JSON.stringify(concern))}`,
        astronaut_id: id,
        at,
        source: 'camera_supported_fatigue_concern',
        ...concern,
        affects_assessment: false,
      }
      m.fatigue_concerns.push(entry)
      save(m)
      return entry
    },

    /** This crew member's fatigue concerns, newest last. */
    fatigueConcerns: (id, limit = 5) => load(id).fatigue_concerns.slice(-limit),

    /** This crew member's camera observations, newest last. */
    observations: (id, limit = 5) => load(id).observations.slice(-limit),

    validAnswers: (id, workflow) => validAnswers(load(id), workflow),

    /** The last answer to each question, however old, with its age in minutes. For context only, never reused. */
    lastAnswers(id, workflow) {
      const t = now()
      return Object.fromEntries(
        Object.entries(load(id).answers[workflow] ?? {}).map(([q, a]) => [q, { ...a, age_minutes: Math.round((t - Date.parse(a.at)) / 60000) }]),
      )
    },

    /** What the astronaut reported, in their words as MeBo understood them. */
    recordSymptom(id, text, { workflow = null } = {}) {
      const m = load(id)
      const entry = { id: `sym-${short(id + text + now())}`, at: nowIso(now), text: note(text), workflow, source: 'crew_report' }
      m.symptoms.push(entry)
      save(m)
      return entry
    },

    /** A short note on a conversation, written by MeBo. */
    recordConversation(id, text, { workflow = null } = {}) {
      const m = load(id)
      const entry = { id: `conv-${short(id + text + now())}`, at: nowIso(now), text: note(text), workflow, source: 'mebo' }
      m.conversations.push(entry)
      save(m)
      return entry
    },

    /**
     * File an assessment result: a linked summary, the answers given (for
     * reuse within their windows), and the concerns it opens or closes. Only
     * the rules' own output is used — nothing here re-grades anything.
     */
    recordAssessment(id, result, { explicitAnswers = {} } = {}) {
      if (result?.crew?.id !== id) {
        throw new MedicalError(400, `Assessment belongs to ${result?.crew?.id}, not ${id}`)
      }
      const m = load(id)
      const at = nowIso(now)
      const wf = result.workflow
      m.assessments.push({
        assessment_id: result.trace.assessment_id,
        at,
        workflow: wf,
        status: result.status,
        level: result.level,
        summary: result.summary,
        rule_ids: result.evidence.map((e) => e.rule_id),
        missing: result.missing.filter((x) => x.required).map((x) => x.label),
        scenario_now: result.mission_context?.scenario_now ?? null,
        dataset_sha256: result.trace.dataset_sha256,
        inputs_sha256: result.trace.inputs_sha256,
      })

      // Only answers the astronaut gave in this conversation are stored; a
      // reused answer keeps its original time, so windows never extend.
      m.answers[wf] ??= {}
      for (const q of Object.keys(explicitAnswers)) {
        if (result.answers?.[q] === undefined) continue
        m.answers[wf][q] = { value: result.answers[q], at, assessment_id: result.trace.assessment_id }
      }

      const outcome = Object.fromEntries(result.rules_evaluated.map((r) => [r.id, r.result]))
      const opened = []
      const closed = []

      // Close what the rules now say is gone. Only a complete assessment can
      // close a concern: missing data is never evidence that something passed.
      if (result.status === 'complete') {
        for (const c of m.concerns) {
          if (c.status !== 'open' || c.workflow !== wf) continue
          if (c.kind === 'incomplete' || outcome[c.rule_id] === false) {
            c.status = 'resolved'
            c.resolved_at = at
            c.resolved_by = result.trace.assessment_id
            closed.push(c.id)
          }
        }
      }

      // Open (or refresh) what the rules found.
      for (const e of result.evidence.filter((e) => CONCERN_LEVELS.has(e.level))) {
        const open = m.concerns.find((c) => c.status === 'open' && c.workflow === wf && c.rule_id === e.rule_id)
        if (open) {
          open.last_seen_at = at
          open.last_assessment_id = result.trace.assessment_id
          open.level = e.level
          continue
        }
        const c = {
          id: `con-${short(id + wf + e.rule_id + at)}`, kind: 'finding', workflow: wf, workflow_title: result.workflow_title,
          rule_id: e.rule_id, title: e.title, level: e.level, text: e.statement, status: 'open',
          opened_at: at, last_seen_at: at, opened_by: result.trace.assessment_id, last_assessment_id: result.trace.assessment_id,
        }
        m.concerns.push(c)
        opened.push(c.id)
      }

      // An unfinished assessment is something to come back to.
      if (result.status === 'incomplete' && !m.concerns.some((c) => c.status === 'open' && c.workflow === wf && c.kind === 'incomplete')) {
        const c = {
          id: `con-${short(id + wf + 'incomplete' + at)}`, kind: 'incomplete', workflow: wf, workflow_title: result.workflow_title,
          rule_id: null, title: 'Assessment not finished', level: 'none',
          text: result.missing.filter((x) => x.required).map((x) => x.label).join(', '),
          status: 'open', opened_at: at, last_seen_at: at, opened_by: result.trace.assessment_id, last_assessment_id: result.trace.assessment_id,
        }
        m.concerns.push(c)
        opened.push(c.id)
      }

      save(m)
      return { recorded: result.trace.assessment_id, concerns_opened: opened, concerns_resolved: closed }
    },

    /** The most recent camera observation across the crew, for the panel, or null. */
    latestObservation() {
      let best = null
      for (const id of crewIds()) {
        if (!existsSync(join(dir, `${id}.json`))) continue
        const last = load(id).observations.at(-1)
        if (last && (!best || last.at > best.at)) best = last
      }
      return best
    },

    /** The most recent assessment of each workflow, across the crew, for the panel. */
    latest() {
      const out = {}
      for (const id of crewIds()) {
        if (!existsSync(join(dir, `${id}.json`))) continue
        for (const a of load(id).assessments) {
          if (!out[a.workflow] || a.at > out[a.workflow].at) out[a.workflow] = { ...a, astronaut_id: id }
        }
      }
      return out
    },
  }
}
