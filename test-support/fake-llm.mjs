/**
 * A scripted stand-in for the language model, for integration tests (Step 28).
 *
 * One small HTTP server that speaks both protocols the bridge can use:
 *   POST /v1/chat/completions   Hugging Face's OpenAI-compatible router (SSE)
 *   POST /api/chat              Ollama's native chat API (NDJSON)
 * so the REAL bridge, agent loop, provider adapters, medical tools, service
 * and SQLite database are all exercised — only the model is replaced by a
 * fixed script. It does what MeBo's prompt asks: find the crew member, call
 * the right tool, and speak only what the tool returned.
 *
 * Stateless, like a real model: each request decides from the conversation
 * it is sent. Every request and every tool result it sees is logged for the
 * test (log()). Kept outside test/ because `node --test` runs every file
 * under a test directory.
 */

import { createServer } from 'node:http'

const SYMPTOMS = ['chest_pain', 'short_of_breath', 'fainted', 'weak_or_lightheaded', 'radiating_pain', 'palpitations']

/** What the script does next, from the conversation since the last question. */
function decide(messages, toolNames) {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  const text = String(messages[lastUser]?.content ?? '')
  const since = messages.slice(lastUser + 1)
  const results = Object.fromEntries(
    since.filter((m) => m.role === 'tool').map((m) => [m.name ?? m.tool_name, String(m.content ?? '')]),
  )
  const parsed = (name) => {
    const r = results[name]
    if (r === undefined) return undefined
    if (r.startsWith('Error')) return { __error: r }
    return JSON.parse(r)
  }
  const call = (name, args) => ({ call: { name, args } })
  const say = (s) => ({ say: s })

  if (!toolNames.includes('list_crew')) return say("I do not have Novak's cardiovascular records on this console.")

  if (/^\s*(mebo,?\s*)?explain\b/i.test(text)) {
    const found = parsed('search_space_medical_knowledge')
    if (!found) return call('search_space_medical_knowledge', { query: text, max_results: 1 })
    if (!found.found) return say('The NASA and CSA sources in my library do not cover that.')
    return say(`${found.results[0].text.split('\n')[0]} Source: ${found.results[0].citation}`)
  }

  const crew = parsed('list_crew')
  if (!crew) return call('list_crew', {})
  const name = /\b(reyes|okafor|chen|novak)\b/i.exec(text)?.[1]
  const who = crew.crew?.find((c) => c.callsign.toLowerCase() === name?.toLowerCase())
  if (!who) return say('Which crew member am I speaking with?')

  if (/\bcamera check\b/i.test(text)) {
    const seen = parsed('request_visual_observation')
    if (!seen) return call('request_visual_observation', { crew_id: who.id })
    if (seen.__error) return say(`The camera check did not work. ${seen.__error.replace(/^Error:\s*/, '')}`)
    const sf = seen.sleep_fatigue
    const sleep = sf?.declined
      ? ' Sleep and fatigue check declined: nothing can be concluded.'
      : sf?.guidance
        ? ` Sleep and fatigue check: ${sf.level.toUpperCase()}. ${sf.guidance}` + (sf.fatigue_concern ? ` ${sf.fatigue_concern.spoken}` : '')
        : ''
    return say(`${who.callsign}: ${seen.description}${sleep}`)
  }

  const result = parsed('assess_cardiovascular')
  if (!result) {
    const answers = /\bno symptoms\b/i.test(text) ? Object.fromEntries(SYMPTOMS.map((k) => [k, 'no'])) : {}
    return call('assess_cardiovascular', { crew_id: who.id, answers })
  }
  return say(`${who.callsign}: ${result.summary} ${result.escalation.guidance}`)
}

/** The arguments a tool call was made with, by its id (OpenAI) or position (Ollama). */
function toolInputs(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) out.push({ id: tc.id, name: tc.function.name, args: tc.function.arguments })
  }
  return out
}

/**
 * Start the fake model. Returns { port, url, requests, toolResults, close }.
 * @param opts.token  the bearer token the Hugging Face path must send (default 'test-token')
 */
export function startFakeLlm({ token = 'test-token' } = {}) {
  const requests = []
  const toolResults = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let input
      try {
        input = JSON.parse(body)
      } catch {
        res.writeHead(400).end('bad json')
        return
      }
      const openai = req.url === '/v1/chat/completions'
      const ollama = req.url === '/api/chat'
      if (!openai && !ollama) return res.writeHead(404).end('not found')
      if (openai && req.headers.authorization !== `Bearer ${token}`) {
        return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid credentials' }))
      }
      const messages = input.messages ?? []
      const toolNames = (input.tools ?? []).map((t) => t.function?.name)
      requests.push({ protocol: openai ? 'openai' : 'ollama', model: input.model, system: messages[0]?.role === 'system' ? messages[0].content : '', tools: toolNames, messages, raw: input })

      // Record the tool results this request carries that were not seen before.
      const inputs = toolInputs(messages)
      messages.forEach((m, i) => {
        if (m.role !== 'tool') return
        const name = m.name ?? m.tool_name
        const key = `${requests.length}:${i}`
        const prior = toolResults.find((r) => r.messageIndex === i && r.name === name && r.callId === (m.tool_call_id ?? null))
        if (prior) return
        const callIn = m.tool_call_id ? inputs.find((x) => x.id === m.tool_call_id) : inputs.filter((x) => x.name === name).at(-1)
        let args = callIn?.args ?? {}
        if (typeof args === 'string') args = JSON.parse(args || '{}')
        const text = String(m.content ?? '')
        toolResults.push({ key, messageIndex: i, callId: m.tool_call_id ?? null, name, input: args, isError: text.startsWith('Error'), text })
      })

      const next = decide(messages, toolNames)
      if (openai) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
        if (next.say) {
          for (const part of next.say.match(/[^.]+\.?\s*/g) ?? [next.say]) sse({ choices: [{ index: 0, delta: { content: part } }] })
          sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        } else {
          const id = `call_fake_${requests.length}`
          const args = JSON.stringify(next.call.args)
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: next.call.name, arguments: '' } }] } }] })
          // Arguments arrive in pieces, as a real stream sends them.
          for (let i = 0; i < args.length; i += 7) sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 7) } }] } }] })
          sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        }
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        const line = (o) => res.write(JSON.stringify(o) + '\n')
        if (next.say) {
          for (const part of next.say.match(/[^.]+\.?\s*/g) ?? [next.say]) line({ model: input.model, message: { role: 'assistant', content: part }, done: false })
        } else {
          line({ model: input.model, message: { role: 'assistant', content: '', tool_calls: [{ function: { name: next.call.name, arguments: next.call.args } }] }, done: false })
        }
        line({ model: input.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' })
        res.end()
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ port, url: `http://127.0.0.1:${port}`, requests, toolResults, close: () => new Promise((r) => server.close(r)) })
    })
  })
}
