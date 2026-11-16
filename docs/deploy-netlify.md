# Deploying MeBo on Netlify

On Netlify, MeBo runs in two parts on one site:
- **The app** (`dist/`) is served by Netlify's CDN, including the Piper voice
  and the MediaPipe face model.
- **The existing bridge** (`bridge/server.mjs`) runs unchanged on **Netlify
  Server** (`netlify/server/index.mjs`): a long-lived Node 24 process that
  holds MeBo's WebSocket.

Netlify Functions cannot host the bridge. They have no WebSockets and a
60-second limit, and a camera check can take ten minutes.

```
browser ──https──▶ CDN: index.html, JS, models
        ──wss /ws, https /health /medical /tts──▶ Netlify Server: the bridge
                                                     ├─ Hugging Face (HF_TOKEN, server-side)
                                                     ├─ SQLite rebuilt in /tmp at start (synthetic, ~0.25 s)
                                                     └─ crew memory: /tmp + Netlify Blobs (per visitor)
```

Offline Ollama mode needs the crew's own machine and GPU, so it stays a local
feature (`npm start`). The hosted site uses Hugging Face only.

## Requirements

- **Plan:** Netlify Server is in Early Access, available on credit-based plans
  only. On Free and Personal plans it runs one `small` instance. Netlify
  describes it as for "evaluation, experimentation, and low-volume production
  use".
- **Node.js:** 24 or later. `netlify.toml` sets `NODE_VERSION = "24"`.
- **A Hugging Face token** with only the "Make calls to Inference Providers"
  permission.

## Configuration

`netlify.toml` sets three things:
- **Build:** `node scripts/netlify-build.mjs`, which fetches the voice and
  face models, vendors the MediaPipe runtime and runs `npm run build`.
- **Publish directory:** `dist`.
- **Browser setting:** `VITE_BRIDGE_URL=same-origin`, so the page talks to
  `wss://<site>/ws` and `https://<site>`.

Set these in **Site configuration → Environment variables**, scoped to
**Functions**, which is the scope the server reads. Never use a `VITE_` name
for a secret.

| Variable | Value |
|---|---|
| `HF_TOKEN` | your token (mark it secret) |
| `LLM_MAX_CALLS_PER_HOUR` | total model calls per hour per instance (default 300) |
| `MEBO_VISITOR_CALLS_PER_HOUR` | model calls per visitor per hour (default 40) |
| `MEBO_VISITOR_WRITES_PER_HOUR` | medical-API writes and speech requests per visitor per hour (default 200) |
| `MEBO_VISITOR_CONNECTIONS` / `MEBO_MAX_CONNECTIONS` | open conversations per visitor (2) and in total (100) |
| `LLM_MAX_OUTPUT_TOKENS` | output tokens per model call (default 800) |
| `MEBO_ALLOWED_HOSTS` / `MEBO_ALLOWED_ORIGINS` | only for a custom domain the defaults below do not cover |

The server entry (`netlify/server/index.mjs`) sets everything else, unless
you override it:
- the port and bind address;
- public mode;
- `LLM_PROVIDER=huggingface`;
- Netlify Blobs for crew memory;
- `/tmp` paths for the database, memory and workspace;
- the knowledge library's path;
- the allowed hosts and origins, taken from Netlify's `URL`,
  `DEPLOY_PRIME_URL` and `DEPLOY_URL`.

**Protect the site.** Turn on password protection or team login under
Site configuration → Access & security. The bridge has no user accounts of its
own. Visitors are kept apart (below), but anyone who can open the site can
spend your inference budget, within the limits above.

## Public mode (what changes when hosted)

This is in `bridge/public.mjs`, enabled by `MEBO_PUBLIC=1`.

- **Visitors are isolated.** The bridge gives each browser a random visitor id
  in an `HttpOnly; Secure; SameSite=Strict` cookie. Each visitor has a private
  crew memory: symptoms, answers, assessments, camera observations and fatigue
  concerns. No visitor can see another's. The synthetic medical database is
  read-only and shared.
- **Memory is durable.** Every memory write goes to local `/tmp` files and is
  copied to Netlify Blobs (store `mebo-crew-memory`, key `<visitor>/<crew>.json`).
  On a new instance, a visitor's files are restored on first use. The server
  sleeps after 5 idle minutes and is replaced every 8 hours. Memory survives
  both, but an open conversation's chat history does not; the page reconnects.
- **Limits are enforced on the server:**
  - model calls per visitor per hour, plus the global per-hour cap;
  - output tokens per model call;
  - open connections per visitor and in total;
  - question length (1,000 characters);
  - medical-API writes and speech requests per visitor per hour.

  When a visitor reaches the call limit, MeBo says so, instead of failing
  silently.
- **No open proxies.** The original assistant's page, image and file proxies
  (`/page`, `/img`, `/media`, `/file`) are switched off.

## Local preview

To exercise the hosted configuration on your own machine:

```bash
PORT=8787 MEBO_ALLOWED_ORIGINS=http://localhost:5173 MEBO_DURABLE_MEMORY=dir:/tmp/mebo-durable \
  MEBO_COOKIE_INSECURE=1 node netlify/server/index.mjs
```

Here a folder stands in for Netlify Blobs, and the cookie is not marked Secure
so plain HTTP works.

## Not yet verified on Netlify itself

Everything above has been tested locally:
- the real bridge;
- the Netlify entry;
- the folder-backed durable store;
- the real Hugging Face model.

Three things can only be confirmed by a deploy:
1. **Netlify Blobs** through `@netlify/blobs` inside Netlify Server. It uses
   the same adapter interface as the tested folder store.
2. **The `Host` and origin values** Netlify forwards, and whether `URL` and
   `DEPLOY_PRIME_URL` reach the server at runtime. If requests come back `403`,
   set `MEBO_ALLOWED_HOSTS` and `MEBO_ALLOWED_ORIGINS` explicitly.
3. **The 63 MB Piper voice from the CDN.** If it fails to load, MeBo falls
   back to the Kokoro voice, then the system voice.
