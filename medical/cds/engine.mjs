/**
 * MeBo's clinical decision-support engine: a small, transparent rules engine.
 *
 * Why not an existing CDS engine (CQL / OpenCDS / CDS Hooks / SNOMED)? See
 * docs/clinical-decision-support.md §2. In short: none ships content for
 * spaceflight vital signs, and each would add a JVM, a translator or a FHIR
 * layer to run a couple of dozen rules. What is reused instead is published
 * clinical *knowledge* (NEWS2 bands, ACC/AHA blood-pressure categories, CDC
 * warning signs, the AASM/SRS sleep consensus), encoded here verbatim and
 * cited rule by rule.
 *
 * Properties the design guarantees, and the tests check:
 *   - Every rule is data: id, level, basis, references, inputs, wording. No
 *     rule text, threshold or recommendation comes from a language model.
 *   - A rule whose inputs are missing evaluates to null (not evaluable),
 *     never false, so missing data can never read as "no concern".
 *   - Pure and deterministic: no clock, no network, no randomness. The same
 *     data and answers always give the same result, down to its id.
 *   - Every result traces to the rules that fired, the observations they
 *     read (by database id), and the dataset checksum.
 */

import { createHash } from 'node:crypto'
import { REFERENCES } from '../references.mjs'
import { CLINICAL_REFERENCES } from './references.mjs'

export const ENGINE_VERSION = 1

export const LEVELS = ['none', 'monitor', 'review', 'urgent', 'emergency']
const rank = (l) => LEVELS.indexOf(l)

/**
 * What to do at each level. Predefined and fixed: an assistant relays these,
 * it does not compose them. The terrestrial sources say "call 911" or "call
 * your health care professional"; on a spacecraft those become the crew
 * medical officer (CMO) and the ground flight surgeon. That mapping is a
 * MeBo prototype assumption (see the docs), informed by S1's point that on a
 * Mars mission "planning and self-sufficiency will be key".
 */
export const ESCALATION = {
  none: 'No escalation. Continue routine monitoring.',
  monitor: 'No escalation needed now. Continue routine monitoring and repeat at the next scheduled check.',
  review:
    'Report to the crew medical officer at the next opportunity, and include it in the next routine ' +
    'medical conference with the ground flight surgeon.',
  urgent:
    'Inform the crew medical officer now. The crew medical officer should consult the ground flight ' +
    'surgeon at the earliest communication opportunity.',
  emergency:
    'Alert the crew medical officer immediately and follow onboard emergency procedures. Notify the ground ' +
    'flight surgeon at once; with communication delays on a Mars transit, the crew acts first.',
}

export const INCOMPLETE_GUIDANCE =
  'Assessment incomplete: obtain the missing items listed and repeat the assessment. The absence of a ' +
  'concern in an incomplete assessment is not reassurance.'

export const BASES = {
  published: 'Threshold and response taken from the cited published source.',
  'published-adapted':
    'Threshold or warning sign from the cited published source; the escalation level is a MeBo prototype mapping of it to spaceflight.',
  prototype: 'MeBo prototype assumption. Not taken from a published clinical source.',
}

export const ALL_REFERENCES = { ...REFERENCES, ...CLINICAL_REFERENCES }

/** JSON with sorted keys, so hashes do not depend on property order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

/** Read `a.b.c` from the context. */
export function read(ctx, path) {
  let v = ctx
  for (const p of path.split('.')) {
    if (v === null || v === undefined) return undefined
    v = v[p]
  }
  return v
}

const available = (v) => v !== undefined && v !== null

/**
 * Evaluate one workflow against a context.
 *
 * @param workflow { id, version, title, inputs: [{path, label, required, action}], rules: [...] }
 * @param ctx      { crew, mission, data, answers, dataset_sha256 }
 */
export function evaluate(workflow, ctx) {
  const evaluated = []
  const fired = []

  for (const rule of workflow.rules) {
    const missingInputs = rule.requires.filter((p) => !available(read(ctx, p)))
    if (missingInputs.length) {
      evaluated.push({ id: rule.id, result: null, missing: missingInputs })
      continue
    }
    const hit = Boolean(rule.when(ctx))
    evaluated.push({ id: rule.id, result: hit })
    if (!hit) continue
    fired.push({
      rule_id: rule.id,
      title: rule.title,
      level: rule.level,
      basis: rule.basis,
      basis_note: BASES[rule.basis],
      statement: typeof rule.statement === 'function' ? rule.statement(ctx) : rule.statement,
      inputs: Object.fromEntries(rule.requires.map((p) => [p, read(ctx, p)])),
      // Observation rows behind the inputs, for traceability.
      observation_ids: [
        ...new Set(
          rule.requires
            .filter((p) => p.startsWith('data.'))
            .map((p) => ctx.data?.[p.split('.')[1]]?.observation_id)
            .filter((id) => id !== null && id !== undefined),
        ),
      ],
      refs: rule.refs.map((id) => ({ id, title: ALL_REFERENCES[id].title, url: ALL_REFERENCES[id].url })),
      next: rule.next ?? [],
    })
  }

  // Missing inputs, with the reason each is missing and what to do.
  const missing = []
  for (const input of workflow.inputs) {
    // Some inputs only apply in some situations (the self-harm question is
    // asked only when mood is low); where they do not apply they are not missing.
    if (input.when && !input.when(ctx)) continue
    if (available(read(ctx, input.path))) continue
    let reason = 'not answered'
    if (input.path.startsWith('data.')) {
      const key = input.path.split('.')[1]
      const d = ctx.data?.[key]
      reason = !d?.last_reading
        ? 'no reading recorded'
        : d.last_reading.stale
          ? `no current reading — the last one is ${d.last_reading.age_hours} h old`
          : 'not enough data for this calculation'
    }
    missing.push({ input: input.path, label: input.label, required: input.required, reason, action: input.action })
  }

  const top = fired.reduce((acc, f) => (rank(f.level) > rank(acc) ? f.level : acc), 'none')
  const incomplete = missing.some((m) => m.required)

  // Next assessments, de-duplicated, in rule order, then missing-data actions.
  const nextMap = new Map()
  for (const f of fired) for (const n of f.next) nextMap.set(n, [...(nextMap.get(n) ?? []), f.rule_id])
  for (const m of missing) if (m.action) nextMap.set(m.action, [...(nextMap.get(m.action) ?? []), `missing:${m.input}`])

  const ordered = [...fired].sort((a, b) => rank(b.level) - rank(a.level))
  const summary = fired.length
    ? `${top.toUpperCase()}: ${ordered.map((f) => f.title).join('; ')}.`
    : incomplete
      ? 'INCOMPLETE: required information is missing, so no conclusion is drawn.'
      : 'No concerns identified by the rules.'

  const body = {
    workflow: workflow.id,
    workflow_title: workflow.title,
    ruleset_version: workflow.version,
    engine_version: ENGINE_VERSION,
    crew: ctx.crew,
    mission_context: ctx.mission,
    status: incomplete ? 'incomplete' : 'complete',
    level: top,
    summary,
    observations: ctx.data,
    answers: ctx.answers,
    evidence: fired,
    concerns: ordered.map((f) => ({ rule_id: f.rule_id, level: f.level, text: f.statement })),
    missing,
    next_assessments: [...nextMap.entries()].map(([text, from]) => ({ text, from })),
    escalation: {
      level: top,
      guidance: ESCALATION[top],
      ...(incomplete ? { incomplete: INCOMPLETE_GUIDANCE } : {}),
      rule_ids: fired.filter((f) => f.level === top).map((f) => f.rule_id),
    },
    rules_evaluated: evaluated,
  }

  const inputsDigest = sha256(canonical({ crew: ctx.crew?.id, mission: ctx.mission, data: ctx.data, answers: ctx.answers }))
  return {
    ...body,
    trace: {
      engine_version: ENGINE_VERSION,
      ruleset: `${workflow.id}@${workflow.version}`,
      dataset_sha256: ctx.dataset_sha256 ?? null,
      inputs_sha256: inputsDigest,
      assessment_id: sha256(canonical(body)).slice(0, 16),
    },
  }
}
