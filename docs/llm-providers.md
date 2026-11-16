# Model providers (Step 28)

MeBo's conversation runs on one of two language-model providers, chosen
when the bridge starts:

| `LLM_PROVIDER` | Where it runs | Model | Needs |
|---|---|---|---|
| `huggingface` | Hugging Face Inference Providers (online) | `google/gemma-4-26B-A4B-it` | `HF_TOKEN` on the bridge |
| `ollama` | Local Ollama server (offline) | `gemma4:e4b` | `ollama pull gemma4:e4b` |

When `LLM_PROVIDER` is not set, MeBo uses `huggingface` if `HF_TOKEN` is set,
and otherwise `ollama`. Every setting is listed in `.env.example`. The bridge
reads them from its environment, or from a git-ignored `.env` file in the
project root.

## How it fits

```
page ──websocket──▶ bridge/server.mjs ──▶ bridge/llm/agent.mjs ──▶ bridge/llm/providers.mjs ──▶ HF router | Ollama
                                              │
                                              └─ tool calls ─▶ bridge/medical-tools.mjs ─▶ medical/ (rules engine, SQLite, memory)
```

- **`providers.mjs`** holds one interface,
  `chat({ messages, tools, signal, onText })`. It returns `{ content, toolCalls }`,
  and its two adapters each stream text:
  - Hugging Face, through the OpenAI-compatible router (`/v1/chat/completions`);
  - Ollama, through its native `/api/chat`, with thinking turned off for
    speed and a 16k context.
- **`agent.mjs`** runs the multi-turn tool cycle:
  - it sends the question, runs each tool call, and feeds the result back
    until the model answers;
  - it keeps the conversation history per connection, and limits each
    question to at most 12 rounds of tool calls;
  - interrupts, timeouts and errors end the turn cleanly.

  It emits the same message shapes the bridge's pump already handled, so the
  page protocol is unchanged: text deltas, tool badges, `done` and
  `error`.
- **Tools.** The model gets the 13 medical tools from `medical/tools.mjs`,
  plus `request_visual_observation` (the guided camera check, run in the
  page). Their names, descriptions and JSON Schemas are passed through
  unchanged, and every call goes through the same handler and argument
  validation as before.
- **Clinical decisions stay deterministic.** The model chooses which tool to
  call and relays the result. The rules engine, the fatigue classification and
  memory decide everything clinical. The guided health check (Step 27) makes
  no model calls at all.
- **The browser never sees a credential.** The token stays in the bridge
  process. `/health` reports only the provider and model name, and a failed
  call is logged without its token.

## Running it

```bash
# Online (Hugging Face): put HF_TOKEN=hf_... in .env, then
npm start

# Offline (Ollama): with Ollama running and gemma4:e4b pulled
LLM_PROVIDER=ollama npm start
```

## Measured on the development machine

These figures are for Ollama `gemma4:e4b` on a GTX 1070 (8 GB), with Ollama's
CUDA backend:
- 100% of the model on the GPU;
- a turn with tool calls takes 8–40 s once warm;
- the first call takes about 50 s, while the model loads.

Two things changed these numbers:
- **GPU backend.** Ollama first ran on the CPU, at 55–100 s a turn, because
  the installed package had no NVIDIA backend. Reinstalling it from
  ollama.com fixed this.
- **Prompt rule.** A "tools before words" rule now sits at the end of the
  open-model prompt. Without it, the small model sometimes described a check
  without calling the tools.

## Limits

- **Medical tools only.** The model is offered the medical tools and the
  guided camera check, nothing else. The original assistant's web search,
  Chrome control, HUD blades, interface retinting and camera snapshots
  depended on the Claude Agent SDK and were removed with it.
- **Paraphrasing.** `gemma4:e4b` is small. It sometimes paraphrases instead of
  quoting the guidance. The guided health check speaks the rules engine's text
  directly, so this applies only to free conversation.
- **Verification.** Both providers passed live end-to-end tool cycles
  through the bridge (Hugging Face `google/gemma-4-26B-A4B-it`: about 1–6 s a
  turn; Ollama `gemma4:e4b` on the GPU: about 8–40 s). Offline mode has not
  yet been tested with the network physically disconnected; during a full
  conversation the bridge and Ollama made only loopback connections.
