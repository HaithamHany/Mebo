/**
 * Clinical decision support: the two assessment workflows and the structured
 * self-assessment that feeds them.
 *
 *   questions(service, crewId, workflow)  → the questions to ask, in order
 *   assess(service, crewId, workflow, answers) → a structured assessment
 *
 * LLM-independent: callable from the bridge (Claude), the HTTP API, the CLI,
 * or a future offline model, with identical results.
 */

import { MedicalError, NOTICE } from '../service.mjs'
import { evaluate } from './engine.mjs'
import { buildContext } from './context.mjs'
import { QUESTIONS, validateAnswers } from './questions.mjs'
import { CARDIOVASCULAR } from './cardiovascular.mjs'
import { SLEEP_FATIGUE } from './sleep-fatigue.mjs'
import { knowledgeBase } from '../knowledge/search.mjs'

export const BACKGROUND_NOTE =
  'NASA/CSA background for whoever reads this assessment, quoted from the source pages. It is not an input ' +
  'to any rule: the level, concerns, missing items and escalation above were decided before it was ' +
  'attached, and nothing in it can change them.'

/**
 * The workflow's background passages. Attached after evaluation, outside the
 * traced body, so retrieved text can never reach a rule, the level, or the
 * assessment id.
 */
function backgroundFor(workflow, kb) {
  // Background is optional context: a knowledge base that is missing or
  // failing costs the background and never the assessment.
  try {
    const base = kb ?? knowledgeBase()
    return {
      role: 'context',
      available: true,
      note: BACKGROUND_NOTE,
      passages: (workflow.background ?? []).map((b) => {
        const p = base.passage(b.passage)
        return p ? { ...p, relevance: b.why } : { passage_id: b.passage, relevance: b.why, missing: true }
      }),
    }
  } catch (err) {
    return { role: 'context', available: false, note: `Knowledge base unavailable: ${err.message}`, passages: [] }
  }
}

export const WORKFLOWS = { [CARDIOVASCULAR.id]: CARDIOVASCULAR, [SLEEP_FATIGUE.id]: SLEEP_FATIGUE }

export const DISCLAIMER =
  'Rule-based decision support from a prototype, applied to synthetic data. It is not a diagnosis and not a ' +
  'treatment, and it does not replace the crew medical officer or the flight surgeon.'

function workflowOf(id) {
  const w = WORKFLOWS[id]
  if (!w) throw new MedicalError(404, `No assessment "${id}". Known: ${Object.keys(WORKFLOWS).join(', ')}.`)
  return w
}

/** The self-assessment questions that apply to this person now, in order. */
export function questions(service, crewId, workflowId) {
  const w = workflowOf(workflowId)
  const ctx = buildContext(service, crewId, w.metrics, {})
  const list = w.questions
    .filter((q) => !q.ask_if || q.ask_if(ctx))
    .map((q) => ({ id: q.id, ...QUESTIONS[q.id] }))
  return {
    simulated: true,
    notice: NOTICE,
    workflow: w.id,
    title: w.title,
    crew: ctx.crew,
    instructions:
      'Ask these questions one at a time, using the wording given. Record each answer exactly ' +
      '(yes/no, or the number for a scale), then run the assessment with all the answers.',
    questions: list,
  }
}

/**
 * Run one assessment. Answers are validated before any rule sees them; the
 * NASA/CSA background is attached only after the rules have decided.
 * `knowledge` overrides the knowledge base (tests use it to prove that no
 * retrieved text can change a result).
 */
export function assess(service, crewId, workflowId, answers = {}, { knowledge } = {}) {
  const w = workflowOf(workflowId)
  const clean = validateAnswers(w, answers)
  const ctx = buildContext(service, crewId, w.metrics, clean)
  const decided = evaluate(w, ctx)
  return { simulated: true, notice: NOTICE, disclaimer: DISCLAIMER, ...decided, background: backgroundFor(w, knowledge) }
}
