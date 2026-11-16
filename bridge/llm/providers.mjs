/**
 * The language-model providers MeBo can run on (Step 28), behind one small
 * interface:
 *
 *   provider.chat({ messages, tools, signal, onText }) → { content, toolCalls }
 *
 *   messages   OpenAI-style chat messages: system, user, assistant (with
 *              tool_calls), tool (with tool_call_id and name)
 *   tools      [{ name, description, input_schema }] — the medical tools'
 *              own JSON Schemas, passed through unchanged
 *   onText     called with each streamed piece of the spoken answer
 *   toolCalls  [{ id, name, arguments }] with arguments already parsed
 *
 * Two implementations, chosen by LLM_PROVIDER:
 *
 *   huggingface  Hugging Face Inference Providers, through the router's
 *                OpenAI-compatible endpoint. HF_TOKEN stays on this server; the
 *                browser never sees it.
 *   ollama       a local Ollama server (native /api/chat). No credentials and
 *                no outside service: works disconnected from the internet.
 *
 * Neither decides anything clinical. The model only chooses which of the
 * medical tools to call and relays what they return; the rules engine and the
 * fatigue classification stay the deterministic authority.
 */

export const DEFAULTS = {
  huggingface: {
    baseUrl: 'https://router.huggingface.co/v1',
    // Gemma 4 26B A4B, served through Hugging Face Inference Providers.
    model: 'google/gemma-4-26B-A4B-it',
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'gemma4:e4b',
  },
}

/** A plain error whose message is safe to log (never carries a credential). */
class ProviderError extends Error {}

const toOpenAiTools = (tools) =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return { __unparsed: raw }
  }
}

/** Lines of a streamed HTTP body, as they arrive. */
async function* lines(body, signal) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal?.aborted) return
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) yield line
      }
    }
    if (buf.trim()) yield buf.trim()
  } finally {
    reader.releaseLock?.()
  }
}

/** fetch with a timeout that also honours the caller's abort. */
async function post(url, body, { headers = {}, signal, timeoutMs }) {
  const ctrl = new AbortController()
  const onAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => ctrl.abort(new ProviderError(`no response within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 300)}`)
    }
    return { res, done: () => clearTimeout(timer), ctrl }
  } catch (err) {
    clearTimeout(timer)
    if (signal?.aborted) throw Object.assign(new ProviderError('cancelled'), { cancelled: true })
    if (ctrl.signal.aborted && ctrl.signal.reason instanceof ProviderError) throw ctrl.signal.reason
    throw err instanceof ProviderError ? err : new ProviderError(String(err?.message ?? err))
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

// --- Hugging Face (OpenAI-compatible router) ------------------------------------------

function huggingFace({ token, model, baseUrl, timeoutMs, maxTokens }) {
  if (!token) throw new ProviderError('LLM_PROVIDER=huggingface needs HF_TOKEN in the bridge environment.')
  return {
    id: 'huggingface',
    model,
    describe: () => `Hugging Face Inference Providers · ${model}`,
    async chat({ messages, tools, signal, onText }) {
      const { res, done } = await post(
        `${baseUrl}/chat/completions`,
        { model, messages, ...(tools.length ? { tools: toOpenAiTools(tools), tool_choice: 'auto' } : {}), stream: true, temperature: 0.3, max_tokens: maxTokens },
        { headers: { authorization: `Bearer ${token}` }, signal, timeoutMs },
      )
      let content = ''
      const calls = new Map()
      try {
        for await (const line of lines(res.body, signal)) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') break
          let chunk
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }
          if (chunk.error) throw new ProviderError(String(chunk.error.message ?? chunk.error))
          const delta = chunk.choices?.[0]?.delta ?? {}
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content
            onText?.(delta.content)
          }
          for (const tc of delta.tool_calls ?? []) {
            const key = tc.index ?? tc.id ?? calls.size
            const c = calls.get(key) ?? { id: tc.id ?? '', name: '', args: '' }
            if (tc.id) c.id = tc.id
            if (tc.function?.name) c.name += tc.function.name
            if (tc.function?.arguments) c.args += tc.function.arguments
            calls.set(key, c)
          }
        }
      } finally {
        done()
      }
      if (signal?.aborted) throw Object.assign(new ProviderError('cancelled'), { cancelled: true })
      const toolCalls = [...calls.values()]
        .filter((c) => c.name)
        .map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: parseArgs(c.args) }))
      return { content, toolCalls }
    },
  }
}

// --- Ollama (native /api/chat) ------------------------------------------------------------

/** OpenAI-style history → Ollama's: tool arguments as objects, tool results named. */
function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls.map((tc) => ({ function: { name: tc.function.name, arguments: parseArgs(tc.function.arguments) } })),
      }
    }
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name }
    return { role: m.role, content: m.content ?? '' }
  })
}

function ollama({ model, baseUrl, timeoutMs, numCtx, maxTokens }) {
  return {
    id: 'ollama',
    model,
    describe: () => `Ollama (local) · ${model}`,
    async chat({ messages, tools, signal, onText }) {
      const { res, done } = await post(
        `${baseUrl}/api/chat`,
        {
          model,
          messages: toOllamaMessages(messages),
          ...(tools.length ? { tools: toOpenAiTools(tools) } : {}),
          stream: true,
          // Spoken answers are short; the model's separate thinking pass only
          // adds seconds of silence before them.
          think: false,
          // Ollama's default context is too short for the tool schemas plus a
          // medical tool result; this fits a whole check comfortably.
          options: { temperature: 0.3, num_ctx: numCtx, num_predict: maxTokens },
          keep_alive: '30m',
        },
        { signal, timeoutMs },
      )
      let content = ''
      const toolCalls = []
      try {
        for await (const line of lines(res.body, signal)) {
          let chunk
          try {
            chunk = JSON.parse(line)
          } catch {
            continue
          }
          if (chunk.error) throw new ProviderError(String(chunk.error))
          const msg = chunk.message ?? {}
          if (typeof msg.content === 'string' && msg.content) {
            content += msg.content
            onText?.(msg.content)
          }
          for (const tc of msg.tool_calls ?? []) {
            if (!tc.function?.name) continue
            toolCalls.push({ id: `call_${Date.now()}_${toolCalls.length}`, name: tc.function.name, arguments: parseArgs(tc.function.arguments) })
          }
          if (chunk.done) break
        }
      } finally {
        done()
      }
      if (signal?.aborted) throw Object.assign(new ProviderError('cancelled'), { cancelled: true })
      return { content, toolCalls }
    },
  }
}

/**
 * The provider this bridge runs on, from the environment:
 *   LLM_PROVIDER   huggingface | ollama   (default: huggingface when HF_TOKEN is
 *                                           set, otherwise ollama)
 *   HF_TOKEN       Hugging Face access token (huggingface only; server-side)
 *   HF_MODEL       default google/gemma-4-26B-A4B-it
 *   HF_BASE_URL    default https://router.huggingface.co/v1
 *   OLLAMA_URL     default http://127.0.0.1:11434
 *   OLLAMA_MODEL   default gemma4:e4b
 *   OLLAMA_NUM_CTX context window for the local model (default 16384)
 *   LLM_MAX_OUTPUT_TOKENS per model call (default 800)
 *   LLM_TIMEOUT_MS per model call (default 120000; a cold local model can be slow to load)
 */
export function providerFromEnv(env = process.env) {
  const choice = (env.LLM_PROVIDER ?? (env.HF_TOKEN ? 'huggingface' : 'ollama')).trim().toLowerCase()
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 120_000
  // Output tokens per model call: spoken answers are short, and this bounds the cost of each call.
  const maxTokens = Number(env.LLM_MAX_OUTPUT_TOKENS) || 800
  if (choice === 'huggingface' || choice === 'hf') {
    return huggingFace({
      token: env.HF_TOKEN,
      model: env.HF_MODEL || DEFAULTS.huggingface.model,
      baseUrl: (env.HF_BASE_URL || DEFAULTS.huggingface.baseUrl).replace(/\/+$/, ''),
      timeoutMs,
      maxTokens,
    })
  }
  if (choice === 'ollama') {
    return ollama({
      model: env.OLLAMA_MODEL || DEFAULTS.ollama.model,
      baseUrl: (env.OLLAMA_URL || DEFAULTS.ollama.baseUrl).replace(/\/+$/, ''),
      timeoutMs,
      numCtx: Number(env.OLLAMA_NUM_CTX) || 16384,
      maxTokens,
    })
  }
  throw new ProviderError(`LLM_PROVIDER must be huggingface or ollama, not "${choice}".`)
}

export { ProviderError }
