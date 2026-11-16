/**
 * MeBo's agent loop on an open model (Step 28): the multi-turn tool cycle
 * the Claude Agent SDK used to run, over any provider in providers.mjs.
 *
 *   user question → model → (tool calls → tools run → results back)* → answer
 *
 * It yields the same message shapes the bridge's pump already reads from
 * the SDK (bridge/server.mjs), so the page protocol does not change:
 *
 *   { type: 'system', subtype: 'init', mcp_servers }        once, at start
 *   { type: 'stream_event', event: content_block_delta }    each piece of speech
 *   { type: 'stream_event', event: content_block_start }    a tool call begins
 *   { type: 'user', message: { content: [tool_result] } }   a tool call ended
 *   { type: 'result', subtype: 'success' | 'error_…' }      the turn is over
 *
 * Tools are the medical tools' own definitions; every call goes through
 * their handlers, which validate arguments (medical/tools.mjs callTool) and
 * return what the deterministic engine computed. The model never sees or
 * sets a threshold. Conversation history lives here for as long as the
 * socket does, like the SDK session it replaces.
 */

/**
 * Model calls allowed per rolling hour, for this bridge process. A cost and
 * abuse guard for paid inference: a stuck loop or a flood of questions stops
 * here instead of on the bill. LLM_MAX_CALLS_PER_HOUR overrides it.
 */
const MAX_CALLS_PER_HOUR = Number(process.env.LLM_MAX_CALLS_PER_HOUR) || 300
const recentCalls = []
function spendCall() {
  const now = Date.now()
  while (recentCalls.length && now - recentCalls[0] > 3_600_000) recentCalls.shift()
  if (recentCalls.length >= MAX_CALLS_PER_HOUR) {
    throw Object.assign(new Error(`model call limit reached (${MAX_CALLS_PER_HOUR} per hour)`), { budget: true })
  }
  recentCalls.push(now)
}

/** Messages kept for context; older ones fall away at a user turn. */
const MAX_HISTORY = 40
/** Longest tool result passed back to the model, in characters. */
const MAX_TOOL_RESULT = 24_000

/**
 * @param o.provider     from providerFromEnv()
 * @param o.systemPrompt string
 * @param o.tools        [{ name, description, input_schema, run(args) → Promise<{ text, isError }> }]
 * @param o.prompt       async iterable of SDK-style user messages ({ message: { content } })
 * @param o.serverName   the MCP-style server name tool calls are announced under (mebo_medical)
 * @param o.maxTurns     model calls per question (default 12)
 * @param o.spend        called before every model call; throws to refuse it
 *                       (a per-visitor limit in public mode). The process-wide
 *                       hourly cap applies as well.
 */
export function createAgentSession({ provider, systemPrompt, tools, prompt, serverName = 'mebo_medical', maxTurns = 12, spend, log = console }) {
  const out = []
  let wake = null
  let ended = false
  let ctrl = null
  const push = (msg) => {
    out.push(msg)
    wake?.()
    wake = null
  }
  const byName = new Map(tools.map((t) => [t.name, t]))
  const history = []

  const trim = () => {
    while (history.length > MAX_HISTORY) {
      history.shift()
      // Never start on a tool result or an assistant turn whose tool results were cut.
      while (history.length && history[0].role !== 'user') history.shift()
    }
  }

  async function runTurn(text) {
    const start = history.length
    history.push({ role: 'user', content: text })
    ctrl = new AbortController()
    const signal = ctrl.signal
    let spoken = ''
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        let answer = ''
        spend?.()
        spendCall()
        const res = await provider.chat({
          messages: [{ role: 'system', content: systemPrompt }, ...history],
          tools,
          signal,
          onText: (delta) => {
            answer += delta
            spoken += delta
            push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } } })
          },
        })
        if (!res.toolCalls.length) {
          history.push({ role: 'assistant', content: res.content })
          trim()
          push({ type: 'result', subtype: 'success', result: res.content || answer, total_cost_usd: null })
          return
        }
        history.push({
          role: 'assistant',
          content: res.content ?? '',
          tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
        })
        for (const call of res.toolCalls) {
          if (signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true })
          push({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: call.id, name: `mcp__${serverName}__${call.name}` } } })
          // Let the bridge put the tool on the HUD before it runs.
          await new Promise((r) => setImmediate(r))
          const t = byName.get(call.name)
          let result
          if (!t) result = { text: `Error: there is no tool named "${call.name}". Use only the tools provided.`, isError: true }
          else if (call.arguments?.__unparsed !== undefined) result = { text: 'Error: the tool arguments were not valid JSON. Call the tool again with a JSON object.', isError: true }
          else {
            try {
              result = await t.run(call.arguments ?? {})
            } catch (err) {
              result = { text: `Error: ${err?.message ?? err}`, isError: true }
            }
          }
          push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, is_error: Boolean(result.isError) }] } })
          const body = result.text.length > MAX_TOOL_RESULT ? `${result.text.slice(0, MAX_TOOL_RESULT)}… [truncated]` : result.text
          history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: body })
        }
      }
      // Ran out of model calls: keep the history consistent and say so.
      push({ type: 'result', subtype: 'error_max_turns', errors: ['too many tool rounds'] })
    } catch (err) {
      // An interrupted or failed turn leaves the question and what was said,
      // never a tool call without its result (providers reject those).
      history.length = start
      history.push({ role: 'user', content: text })
      if (spoken) history.push({ role: 'assistant', content: spoken })
      trim()
      if (!(err?.cancelled || signal.aborted)) log.error?.(`[mebo] ${provider.id} turn failed: ${err?.message ?? err}`)
      // A spending limit is said as such; anything else is a failed turn.
      push({ type: 'result', subtype: err?.budget ? 'error_max_budget_usd' : 'error_during_execution', errors: [String(err?.message ?? err)] })
    } finally {
      ctrl = null
    }
  }

  ;(async () => {
    push({ type: 'system', subtype: 'init', mcp_servers: [{ name: serverName, status: 'connected' }], model: provider.model })
    try {
      for await (const msg of prompt) {
        if (ended) break
        const content = msg?.message?.content
        await runTurn(typeof content === 'string' ? content : String(content ?? ''))
      }
    } finally {
      ended = true
      wake?.()
    }
  })()

  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) {
          yield out.shift()
          continue
        }
        if (ended) return
        await new Promise((r) => (wake = r))
      }
    },
    /** Stop the turn in flight; it ends with an error result the bridge recognises as a cancel. */
    async interrupt() {
      ctrl?.abort()
    },
    close() {
      ended = true
      ctrl?.abort()
      wake?.()
    },
  }
}
