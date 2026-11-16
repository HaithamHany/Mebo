/**
 * MeBo's medical tools, offered to the language model (bridge/llm/agent.mjs).
 *
 * A thin adapter and nothing more. The tools, their schemas and everything
 * they compute live in medical/ (tools.mjs, cds/, memory/, workflows.mjs),
 * which has no dependency on any language model; this file only wraps each
 * call, reports tool activity so the Medical Agents panel can show it, and
 * adds the guided camera check, which runs in the page.
 */

import { TOOLS, callTool } from '../medical/tools.mjs'
import { VISUAL_NOTICE } from '../medical/vision/observations.mjs'

/**
 * The one medical tool that needs the browser: the guided camera check runs
 * where the camera is. Offered only when the bridge can ask the page.
 */
export const VISUAL_TOOL = 'request_visual_observation'

/** The tool names this adapter offers, for the bridge's banner and /health. */
export const MEDICAL_TOOL_NAMES = [...TOOLS.map((t) => t.name), VISUAL_TOOL]

/**
 * How long the page has to run the guided check: five timed tasks, the
 * natural-observation window (up to 180 s), the speech between them, and the
 * sleep and fatigue questions that follow (Step 26C), each waited on for up
 * to 20 s and asked twice.
 */
const VISUAL_TIMEOUT_MS = 600_000

const VISUAL_DESCRIPTION =
  'Run the guided camera check with this crew member, on the console in front of them (about two minutes): ' +
  'MeBo explains it, asks for the camera, and talks them through looking at the camera, a minute of ordinary ' +
  'looking (for PERCLOS and blinks), closing their eyes, turning their head and holding still. Then the console ' +
  'itself continues into the sleep and fatigue check: with their agreement it asks the missing structured ' +
  'questions and runs the rules-based assessment (assess_sleep_fatigue). Returns what the camera observed, the ' +
  'measurement quality, an explanation, and sleep_fatigue: the assessment outcome (level, guidance, missing ' +
  'items) or that they declined, with fatigue_concern: the camera-supported fatigue concern (low, moderate, high ' +
  'or indeterminate; the camera can raise it, never lower the rules). Relay sleep_fatigue.guidance as given, then ' +
  'fatigue_concern.spoken, and do not ask the questions again. ' +
  'Tracking runs locally; no image or video is stored or sent. Camera measures are supplementary: they cannot ' +
  'show tiredness on their own, diagnose, or judge fitness for duty, and never change an assessment or an ' +
  'escalation level. Ask the crew member first; they can decline.'

/**
 * What the Medical Agents panel is told about a tool call: which tool, for
 * whom, and — for an assessment — its outcome. Taken from the tool's own
 * result; never the arguments' free text.
 */
export function activityOf(name, args, result, error) {
  const base = { tool: name, crew_id: typeof args?.crew_id === 'string' ? args.crew_id : null, at: new Date().toISOString() }
  if (error) return { ...base, phase: 'end', ok: false, error: String(error.message ?? error) }
  const out = { ...base, phase: 'end', ok: true }
  if (result?.workflow && result?.trace?.assessment_id) {
    Object.assign(out, {
      workflow: result.workflow,
      level: result.level,
      status: result.status,
      summary: result.summary,
      assessment_id: result.trace.assessment_id,
      callsign: result.crew?.callsign ?? null,
    })
  } else if (result?.workflow?.id) {
    // begin_medical_check
    Object.assign(out, { workflow: result.workflow.id, callsign: result.crew?.callsign ?? null })
  }
  return out
}

/**
 * The medical tools as plain definitions for any model (Step 28):
 * [{ name, description, input_schema, run(args) → { text, isError } }].
 * The same handlers, schemas, activity reports and camera round trip as the
 * MCP server below — only the wrapping differs.
 */
export function medicalTools(getService, { onActivity, askPage } = {}) {
  const report = (a) => {
    try {
      onActivity?.(a)
    } catch {
      /* the panel is a display; it must never break a tool call */
    }
  }
  const unwrap = (r) => ({ text: r.content.map((c) => c.text).join(''), isError: Boolean(r.isError) })
  return [
    ...TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      run: async (args) => unwrap(await runMedical(getService, t, args, report)),
    })),
    ...(askPage
      ? [{
          name: VISUAL_TOOL,
          description: VISUAL_DESCRIPTION,
          input_schema: {
            type: 'object',
            properties: { crew_id: { type: 'string', description: 'Crew member id: cdr, plt, ms1 or ms2.' } },
            required: ['crew_id'],
            additionalProperties: false,
          },
          run: async (args) => {
            if (typeof args?.crew_id !== 'string' || !args.crew_id) return { text: 'Error: request_visual_observation needs "crew_id"', isError: true }
            return unwrap(await runVisual(getService, askPage, report, args))
          },
        }]
      : []),
  ]
}

/** One medical tool call: arguments validated by callTool, activity reported, result as MCP content. */
async function runMedical(getService, t, args, report) {
  report({ tool: t.name, crew_id: typeof args?.crew_id === 'string' ? args.crew_id : null, phase: 'start', at: new Date().toISOString() })
  try {
    const result = callTool(await getService(), t.name, args ?? {})
    report(activityOf(t.name, args, result))
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (err) {
    report(activityOf(t.name, args, null, err))
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
  }
}

/**
 * request_visual_observation. The page runs the check (src/lib/visual/) and
 * files the summary itself; this returns what the page measured and filed —
 * the model supplies only who it is for.
 */
async function runVisual(getService, askPage, report, args) {
  {
    const at = () => new Date().toISOString()
    report({ tool: VISUAL_TOOL, crew_id: args.crew_id, phase: 'start', at: at() })
    try {
      ;(await getService()).summary(args.crew_id) // 404 for an unknown crew member
      const reply = await askPage('visual', { crew_id: args.crew_id }, VISUAL_TIMEOUT_MS)
      if (reply.error) throw new Error(reply.error)
      const result = {
        crew_id: args.crew_id,
        observation_id: reply.recorded?.observation_id ?? null,
        saved: Boolean(reply.saved),
        observation: reply.observation,
        description: reply.description ?? null,
        // Composed by the medical service from the numbers and the crew
        // member's records: relay these; do not add to them.
        explanation: reply.explanation ?? null,
        follow_up: Array.isArray(reply.follow_up) ? reply.follow_up : [],
        // The sleep and fatigue assessment the console ran after the camera
        // (Step 26C): the rules engine's own outcome, or that it was declined.
        sleep_fatigue: reply.sleep_fatigue ?? null,
        notice: VISUAL_NOTICE,
        affects_assessment: false,
      }
      report({ tool: VISUAL_TOOL, crew_id: args.crew_id, phase: 'end', ok: true, at: at() })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (err) {
      report({ tool: VISUAL_TOOL, crew_id: args.crew_id, phase: 'end', ok: false, error: String(err.message ?? err), at: at() })
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  }
}
