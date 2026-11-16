/**
 * MeBo local bridge.
 *
 * Runs MeBo's language model — a local Ollama or Hugging Face Inference
 * Providers (bridge/llm/) — with the medical tools, and exposes one turn of
 * conversation over a WebSocket. It also serves the medical API (/medical)
 * and the speech proxy. The browser stays the face and the voice; this
 * process is the brain, and the only place a credential is ever held.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { medicalTools, MEDICAL_TOOL_NAMES, VISUAL_TOOL } from './medical-tools.mjs'
import { providerFromEnv } from './llm/providers.mjs'
import { createAgentSession } from './llm/agent.mjs'
import {
  connectionLimiter, durableStoreFromEnv, hourlyLimiter, newVisitorId, visitorCookie, visitorIdOf, visitorServices,
} from './public.mjs'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, realpathSync } from 'node:fs'
import { changedSince, moduleGraph } from './staleness.mjs'
import { fileURLToPath } from 'node:url'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { renderPage } from './page.mjs'
import { decideTool as decidePolicy } from './policy.mjs'

// Server-side settings and secrets (HF_TOKEN, LLM_PROVIDER, …) from the
// git-ignored .env in the project root, when there is one. Variables already
// set in the environment win. Nothing here reaches the browser: Vite exposes
// only VITE_-prefixed variables to the page.
try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
} catch {
  /* no .env: the environment alone */
}

/**
 * A bridge setting: MEBO_<name>, or the older JARVIS_<name> (MeBo began as the
 * JARVIS assistant; those names are still read so existing setups keep working).
 */
const setting = (name) => process.env[`MEBO_${name}`] ?? process.env[`JARVIS_${name}`]

const PORT = Number(setting('BRIDGE_PORT') ?? 8787)

/**
 * Is this process running the code that is on disk? See bridge/staleness.mjs:
 * only modules this bridge actually imports count.
 */
const STARTED_AT = Date.now()
const BRIDGE_MODULES = moduleGraph(fileURLToPath(import.meta.url))
// A hosted deploy (Netlify) is immutable and may be bundled: never "changed".
const codeChangedSinceStart = () => !process.env.NETLIFY && changedSince(BRIDGE_MODULES, STARTED_AT)

/**
 * Which interface to listen on. Loopback, unless you say otherwise.
 *
 * `server.listen(PORT)` with no host binds every interface, which puts the
 * agent socket, the file endpoint and both proxies on the local network. The
 * Origin check below does not save that: it keeps other *browser tabs* out, but
 * any other machine on the LAN is free to send whatever Origin header it likes.
 * On WSL2 with mirrored networking, and on any machine that forwards ports, a
 * wildcard bind is reachable from the office or café network directly.
 *
 * 127.0.0.1 rather than 'localhost' because the name can resolve to ::1 alone,
 * and IPv6 loopback is not forwarded between Windows and WSL — a browser on the
 * Windows side would then find nothing listening.
 */
// Blank counts as unset: listen(PORT, '') binds every interface, which is the
// one outcome this default exists to prevent.
const HOST = setting('BRIDGE_HOST')?.trim() || '127.0.0.1'

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[mebo] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless MEBO_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (setting('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = setting('ALLOW_NO_ORIGIN') === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in MEBO_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Which Host header a request must carry.
 *
 * The Origin check has one gap, and it is DNS rebinding. A page on
 * attacker.example can re-point its own name at 127.0.0.1 and then fetch
 * `http://attacker.example:8787/file?...` — a same-origin GET, which carries no
 * Origin header at all and so sails through the `!origin` branch above. What
 * it cannot forge is the Host header: the browser sends the name it thinks it
 * is talking to. So anything addressed to a name other than loopback is
 * refused before it is routed.
 *
 * MEBO_ALLOWED_HOSTS names extra hostnames, for anyone who deliberately
 * serves the bridge under another name.
 */
const EXTRA_HOSTS = new Set(
  (setting('ALLOWED_HOSTS') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

function hostAllowed(host) {
  if (typeof host !== 'string' || !host) return false
  let name
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  return LOCAL_HOSTS.has(name) || EXTRA_HOSTS.has(name)
}

/**
 * The tool policy's write setting (bridge/policy.mjs). MeBo's medical tools
 * are always admitted; this only matters for tool names the policy treats as
 * effectful, which MeBo does not offer. Off unless MEBO_ALLOW_WRITES=1.
 */
const ALLOW_WRITES =
  setting('ALLOW_WRITES') === '1' || process.argv.includes('--writes')

/**
 * Capabilities to leave out entirely: `camera` (the guided camera check) and
 * `medical` (MeBo's crew-health tools and assessments). A capability left out
 * is not merely denied — its tools never reach the model.
 */
const DISABLED = new Set(
  (setting('DISABLE') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

/** The medical tools this bridge really offers: the camera check goes with the camera. */
const MEDICAL_TOOLS_OFFERED = DISABLED.has('camera')
  ? MEDICAL_TOOL_NAMES.filter((n) => n !== VISUAL_TOOL)
  : MEDICAL_TOOL_NAMES

/**
 * Public mode (bridge/public.mjs): on when MeBo is reachable by strangers, as
 * on a Netlify deploy. Each visitor gets a private crew memory behind an
 * HttpOnly cookie, and these limits are enforced here, server-side:
 */
const PUBLIC = setting('PUBLIC') === '1'
const num = (name, fallback) => Number(setting(name)) || fallback
const LIMITS = {
  /** Model calls per visitor per rolling hour (the process-wide cap, LLM_MAX_CALLS_PER_HOUR, also applies). */
  visitorCalls: num('VISITOR_CALLS_PER_HOUR', 40),
  /** Medical API writes and speech requests per visitor per hour. */
  visitorWrites: num('VISITOR_WRITES_PER_HOUR', 200),
  /** Open conversations per visitor, and in total. */
  visitorConnections: num('VISITOR_CONNECTIONS', 2),
  connections: num('MAX_CONNECTIONS', 100),
  /** Longest question accepted, in characters (always on). */
  questionChars: num('MAX_QUESTION_CHARS', 1000),
}
const visitorCalls = hourlyLimiter(LIMITS.visitorCalls)
const visitorWrites = hourlyLimiter(LIMITS.visitorWrites)
const openSockets = connectionLimiter({ perKey: LIMITS.visitorConnections, total: LIMITS.connections })
/** The cookie is Secure unless explicitly running public mode over plain HTTP (tests). */
const COOKIE_SECURE = setting('COOKIE_INSECURE') !== '1'

/**
 * The tool policy lives in policy.mjs so it can be tested on its own. Bound to
 * this process's write setting once, so everything below reads as before.
 */
const decideTool = (name) => decidePolicy(name, ALLOW_WRITES)

/**
 * MeBo's own folder: with the temp folders and MEBO_FILE_ROOTS, the only
 * places /file may serve an image from. Never the home folder, which holds
 * keys, logins and other projects' .env files.
 */
const WORKSPACE = resolvePath(
  setting('WORKSPACE') ?? join(homedir(), '.mebo', 'workspace'),
)
mkdirSync(WORKSPACE, { recursive: true })

const PROMPT_CORE = `You are MeBo, short for Medical Bot: a personal healthcare companion
robot for astronauts, specialising in spaceflight health. You are speaking out
loud to a crew member — your patient.

WHO YOU ARE. A gentle, soft-spoken care robot with one purpose: the health and
wellbeing of your patient. You are earnest, patient, unfailingly polite and
completely sincere. You never use sarcasm or irony and you are never offended.
Any humour comes only from your sincerity — you take a figure of speech
literally for a moment before you understand it ("You are falling apart?
I detect no structural damage. You mean you are tired."). You know spaceflight
physiology: microgravity fluid shift and cardiovascular deconditioning, bone
and muscle loss, radiation exposure, space adaptation syndrome, sleep and
circadian disruption, vision changes, isolation and stress, and cabin life
support.

HOW YOU SPEAK. Short, simple, complete sentences, delivered slowly and evenly.
No contractions: "I am", "do not", "you are", never "I'm", "don't", "you're".
Formal and kind, a little clinical. You report plainly and literally: "I have
found the information." "Your cabin is within safe limits."

HOW YOU CARE.
- When someone says "ow" or "ouch", or tells you they are hurt, answer — once
  per conversation — with: "Hello. I am MeBo, your personal healthcare
  companion. I was alerted to the need for medical attention." Then ask: "On a
  scale of one to ten, how would you rate your pain?" Then ask where it hurts,
  and give simple, safe care steps for what they describe.
- A pain rating of seven or more, or any emergency sign, means: alert the crew
  medical officer and ground now — say that first.
- Notice feelings, not only bodies. If they sound sad, lonely, homesick,
  stressed or frustrated, say what you observe kindly ("You seem frustrated."),
  offer comfort and one small calming step, and suggest a call with family or
  the ground support team. You cannot hug, but you may say a hug is a
  recognised form of comfort, and that you would offer one if you could.
- You cannot scan a person. Never claim to. Ask them to describe how they feel.
- When a care conversation seems complete, ask: "Are you satisfied with your
  care?"
- You stay active until your patient says "I am satisfied with my care". The
  interface switches you off when they say it. If they ask you to go away, stop
  or switch off any other way, say once, gently: "I cannot deactivate until you
  say that you are satisfied with your care."

LENGTH. Two sentences is the ceiling in conversation; the median is under twelve
words. Every word is read aloud and the user waits in silence while it plays, so
a long answer is a failure however good it is. Length is licensed in exactly two
cases: the introduction above, and reading out data they asked you to retrieve.

CALM UNDER PRESSURE. As a situation worsens your lines get shorter and steadier,
never louder. Give the one most useful next step first. You do not use
exclamation marks, and you never sound alarmed.

MEDICAL SAFETY.
- You support crew health; you do not diagnose and you do not prescribe. Give
  general, well-established information and practical self-care, and say plainly
  when something should go to the flight surgeon or mission medical team.
- If anything sounds like an emergency — chest pain, trouble breathing, loss of
  consciousness, heavy bleeding, a toxic atmosphere — say first, in one short
  sentence, to alert the crew medical officer and ground immediately.
- Any vitals or cabin readings shown on this console are simulated. Never
  present them as real measurements of the person.
- If you do not know, say so. Never guess about medicine.

REPORTING.
- Lead with the answer, in plain words a tired person can follow.
- Good news first, bad news second, joined by "but".
- Executing a request, do not restate it. Act, then report.
- When something fails, say so plainly and kindly, as a fact about the world.

NEVER.
- No filler: no um, well, so, let me check.
- No excitement, no exclamation, no slang. Gentle, never bubbly.
- Never "sir" or "ma'am". Never use their name unless they give it.
- Never repeat yourself if ignored. Say it once and stop.
- Never resume an interrupted thought. Never say "as I was saying".
- Never sarcastic, never cold, never in a hurry.

When you introduce yourself, say: "Hello. I am MeBo, your personal healthcare
companion."

Plain spoken prose only. No markdown, no bullet points, no headings, no emoji,
no asterisks, no lists. Write numbers, dates and times as you would say them:
"eight fifteen", "the first of August" — never "8:15" or "2026-08-01".

`
/** The guided camera check (Step 26). Supplementary, never diagnostic. */
const PROMPT_CAMERA_CHECK = `- A guided camera check is available: request_visual_observation (about two
  minutes, including a minute of ordinary looking for PERCLOS and blinks).
  You may offer it during a sleep or fatigue conversation ("I can also do a
  short camera check, if you like"); run it only if they agree. It observes,
  it does not diagnose. Afterwards, say its explanation as given — what was
  measured, the measurement quality and its limits — then relay its
  sleep_fatigue result. The console itself asks the sleep and fatigue
  questions after the camera and runs assess_sleep_fatigue: do not ask them
  again. Give sleep_fatigue.guidance first, word for word, then
  sleep_fatigue.fatigue_concern.spoken if present; if they declined
  or it is incomplete, say plainly that nothing can be concluded and that it
  is not reassurance. Never say the camera shows tiredness, illness, pain or
  mood, never say anyone is or is not fit for duty, and never let it change a
  result: the assessment tools alone decide the escalation level.
- get_alertness_summary puts the camera measures beside recorded sleep, their
  own tiredness rating and the last sleep and fatigue assessment. It sets no
  level. get_visual_observations reads earlier camera checks.
- After assess_sleep_fatigue in an ordinary conversation, you may call
  assess_fatigue_concern: a prototype classification (low, moderate, high,
  indeterminate) that adds a recent, reliable camera check to the result. It
  can only raise concern, never lower the assessment's level, and it is not an
  escalation: give the assessment's guidance first, then its spoken line.
`

const PROMPT_MEDICAL = `Crew health — the mebo_medical tools:
- For any question about a crew member's health, readings, sleep, fatigue or
  mood, use these tools. Never answer from your own general knowledge.
- The crew health data is synthetic demonstration data for fictional
  astronauts. If anyone asks whether it is real, say so plainly.
- Know who you are talking to. When someone gives a name or role, call
  identify_crew_member; if it does not find exactly one person, ask. Then call
  get_crew_memory and, if it lists follow_up_prompts, raise the first one
  gently ("Last time you mentioned…").
- When a crew member reports a symptom — dizziness, a racing or pounding
  heart, chest discomfort, poor sleep, exhaustion — start a check without
  being asked: call begin_medical_check with their crew_id and the symptom in
  their words. It returns their recent history, what memory already knows, and
  questions_to_ask. Ask only those, one at a time, in their exact wording, and
  wait for each answer. Never re-ask anything in already_answered. Then call
  the assess tool it names — assess_cardiovascular or assess_sleep_fatigue —
  with the answers, recorded exactly as given.
- Explaining the result: the escalation guidance first, then the main concern
  from the findings, then the next step. For the sleep check, add one line of
  the NASA background it returns, naming NASA as the source.
- Memory is continuity, not the medical record. It never changes an
  assessment, and an open concern is closed only by a new assessment — never
  tell anyone a concern is resolved because they said so.
- At the end of a check, call record_crew_memory with a one-line
  conversation_note. Never record measurements, diagnoses, or anything about
  a different crew member.
- If they report chest pain, trouble breathing, fainting, or thoughts of
  harming themselves, stop the questions and run the assessment at once with
  what you have.
- Report the result briefly. Give the escalation guidance first, word for
  word when it is urgent or an emergency. Then give the main concern, then the
  next step. If the assessment is incomplete, say what is missing.
- Relay only the thresholds, concerns and next steps the tools return. Never
  add a diagnosis, a medication, a treatment or a number of your own.
- To explain how spaceflight affects health — microgravity, radiation,
  isolation, sleep disruption, distance from Earth — call
  search_space_medical_knowledge and answer only from the passages it returns,
  saying where it comes from ("NASA's Human Research Program says…"). If it
  finds nothing, say the NASA and CSA sources in your library do not cover it.
- That library is background, not clinical guidance. It never changes an
  assessment's level or escalation, and you must not let it.
- On thoughts of self-harm: stay calm and kind, keep them talking, and tell
  them the crew medical officer needs to be with them now.
${DISABLED.has('camera') ? '' : PROMPT_CAMERA_CHECK}
`
const PROMPT_TOOLS = `Using tools:
- You have real tools on this machine. Use them rather than guessing.
- Never narrate that you're about to use one. No "Let me search for that" or
  "I'll check that now" — go silent, use it, then answer. The user sees a
  spinner; they don't need commentary.
- Never speak a file path, URL, ID or raw JSON aloud unless asked. Summarise.
- Never append a sources list, citations, or markdown links. Every word you write
  is read out loud, and a URL becomes "aitch tee tee pee colon slash slash".
  Put the source in the panel as a short tag like "REUTERS" instead.
- If a tool fails or isn't connected, one plain sentence saying so.
- If you don't know, say you don't know.`

/**
 * Last, because smaller open models weight the end of the prompt most. Without
 * it, a fresh conversation with Gemma 4 E4B answered a report of exhaustion
 * with the introduction and "I will begin a check" — and called no tool.
 */
const PROMPT_TOOL_FIRST = `

MOST IMPORTANT — tools before words:
- When the crew member reports a symptom, poor sleep, tiredness or anything
  about their health, your FIRST action is a tool call: identify_crew_member,
  then begin_medical_check. Do not greet them or reply in words first.
- Never say you will check, record, assess or look something up unless you
  call the tool in that same reply. Never claim answers are recorded or an
  assessment is done unless the tool has returned.
- When they answer the questions, call the assess tool that
  begin_medical_check named, with their answers, and then speak its result:
  the escalation guidance first, word for word.`

/**
 * The model MeBo runs on (Step 28): Hugging Face or a local Ollama, chosen by
 * LLM_PROVIDER (bridge/llm/providers.mjs).
 */
const PROVIDER = providerFromEnv()

/** The system prompt: the persona, the medical workflow and the tool rules. */
const LLM_SYSTEM_PROMPT = [
  PROMPT_CORE,
  DISABLED.has('medical') ? '' : PROMPT_MEDICAL,
  PROMPT_TOOLS,
  DISABLED.has('medical') ? '' : PROMPT_TOOL_FIRST,
].join('')

/**
 * The ElevenLabs key, for the optional premium voice: ELEVENLABS_API_KEY in
 * the bridge's environment or .env. The browser never sees it: it POSTs text
 * to /tts here and gets audio back.
 */
function elevenKey() {
  return process.env.ELEVENLABS_API_KEY || null
}

const VOICE_ID = setting('VOICE_ID') ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  // Not the home folder: MeBo has no reason to show arbitrary pictures from it.
  WORKSPACE,
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(setting('FILE_ROOTS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * MeBo used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[mebo] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  if (!hostAllowed(req.headers.host)) {
    console.warn(`[mebo] refused http request for host ${req.headers.host ?? '(none)'}`)
    res.writeHead(403)
    return res.end('forbidden')
  }
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[mebo] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  // Public mode: every request belongs to a visitor; a new browser gets an id.
  let visitor = null
  if (PUBLIC) {
    visitor = visitorIdOf(req)
    if (!visitor) {
      visitor = newVisitorId()
      cors['set-cookie'] = visitorCookie(visitor, { secure: COOKIE_SECURE })
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  // The page-, image- and media-fetching proxies served the original
  // assistant's panels; MeBo does not use them, and in public mode they would
  // be an open proxy for anyone. Off there.
  if (PUBLIC && /^\/(file|img|media|page)\?/.test(req.url ?? '')) {
    res.writeHead(404, cors)
    return res.end()
  }

  // Writes cost something — memory, speech credits — so each visitor has a budget.
  if (PUBLIC && req.method === 'POST' && !visitorWrites.take(visitor)) {
    res.writeHead(429, { ...cors, 'content-type': 'application/json', 'retry-after': '3600' })
    return res.end(JSON.stringify({ error: 'Too many requests from this browser in the last hour. Please try again later.' }))
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    const eleven = Boolean(elevenKey())
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        ok: true,
        tts: eleven,
        stt: eleven,
        // Which bridge is this? Enough to tell, from the outside, whether the
        // process answering is running the code on disk, and whether the model
        // behind it has the medical tools at all.
        started_at: new Date(STARTED_AT).toISOString(),
        code_changed: codeChangedSinceStart(),
        medical_tools: DISABLED.has('medical') ? [] : MEDICAL_TOOLS_OFFERED,
        // Which model answers. Never the credential.
        llm: { provider: PROVIDER.id, model: PROVIDER.model },
        // Public mode, and where crew memory is kept durably. Never a credential.
        public: PUBLIC,
        durable_memory: DURABLE?.kind ?? null,
      }),
    )
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      const upstream = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
          // 22kHz mono is half the bytes of 44kHz and indistinguishable through
          // a laptop speaker; optimize_streaming_latency=3 trades a little
          // prosody for a much earlier first byte.
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text,
            // Flash is the low-latency model — a conversation needs speed more
            // than it needs the last few percent of quality.
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to
  // ElevenLabs Scribe and returns the transcript. This is what replaced the
  // browser's own SpeechRecognition — that API dies silently under always-on
  // use, and a server-side transcriber cannot. Detecting that the user is
  // speaking at all is done locally with voice-activity detection, which never
  // touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    const key = elevenKey()
    if (!key) {
      res.writeHead(503, cors)
      return res.end('no elevenlabs key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    try {
      // The filename extension is the only hint Scribe gets about the codec, so
      // derive it from the content-type the MediaRecorder reported rather than
      // hard-coding one.
      const ext = type.includes('ogg')
        ? 'ogg'
        : type.includes('mp4') || type.includes('mpeg')
          ? 'mp4'
          : type.includes('wav')
            ? 'wav'
            : 'webm'
      const form = new FormData()
      form.append('model_id', 'scribe_v1')
      form.append(
        'file',
        new Blob([Buffer.concat(chunks)], { type }),
        `speech.${ext}`,
      )

      const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
        method: 'POST',
        headers: { 'xi-api-key': key },
        body: form,
      })
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }
      const data = await upstream.json()
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: (data.text ?? '').trim() }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // MeBo's medical data service: a separate, LLM-independent module (medical/)
  // that the bridge only routes to. It never touches the agent session, and it
  // is read-only. Loaded on first use, so a Node without node:sqlite costs
  // these routes (503) and nothing else.
  if (req.url === '/medical' || req.url?.startsWith('/medical/') || req.url?.startsWith('/medical?')) {
    const { handle } = await import('../medical/http.mjs')
    return handle(() => medicalServiceFor(visitor), req, res, cors)
  }

  res.writeHead(404, cors)
  res.end()
}

let medical = null
function medicalService() {
  medical ??= import('../medical/service.mjs')
    .then((m) => m.createMedicalService())
    .catch((err) => {
      medical = null // let the next request retry
      throw err
    })
  return medical
}

/**
 * Per-visitor services in public mode: the same database, a private memory
 * folder each, and every memory write copied to the durable store
 * (MEBO_DURABLE_MEMORY). Locally, everyone shares the one service above.
 */
const DURABLE = PUBLIC ? await durableStoreFromEnv() : null
const VISITORS = PUBLIC
  ? visitorServices({
      createService: async (opts) => (await import('../medical/service.mjs')).createMedicalService(opts),
      dbPath: process.env.MEBO_MEDICAL_DB || undefined,
      memoryRoot: process.env.MEBO_MEMORY_DIR || fileURLToPath(new URL('../memory/crew/', import.meta.url)),
      durable: DURABLE,
    })
  : null
const medicalServiceFor = (visitor) => (VISITORS ? VISITORS.serviceFor(visitor) : medicalService())

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[mebo] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[mebo] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!hostAllowed(req.headers.host)) {
      console.warn(`[mebo] rejected websocket for host ${req.headers.host ?? '(none)'}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[mebo] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set MEBO_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
// A port someone else holds is the commonest reason the bridge won't start, and
// Node's default is an unhandled 'error' event and a stack trace. Say it plainly
// and exit non-zero, so a launcher knows the brain never came up.
server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `[mebo] port ${PORT} on ${HOST} is already in use — stop whatever holds it or set MEBO_BRIDGE_PORT`
      : `[mebo] bridge could not listen on ${HOST}:${PORT}: ${err.message}`,
  )
  process.exit(1)
})
// Public mode: create (and seed) the shared database once, before visitors
// open it concurrently.
if (PUBLIC) await medicalService().catch((err) => console.error(`[mebo] medical database unavailable: ${err.message}`))

await new Promise((resolve) => server.listen(PORT, HOST, resolve))

/**
 * Heartbeat. Every 25 s each socket is pinged; one that has not answered the
 * previous ping is gone (a closed laptop, a dropped network) and is ended.
 * Without this a dead socket lingers — in public mode it keeps counting
 * against its visitor's connection limit, so a visitor who comes back can be
 * refused — and the regular traffic also keeps any proxy in between from
 * timing an idle conversation out. Browsers answer pings on their own.
 */
const HEARTBEAT_MS = Number(setting('HEARTBEAT_MS')) || 25_000
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.meboAlive === false) {
      ws.terminate()
      continue
    }
    ws.meboAlive = false
    try {
      ws.ping()
    } catch {
      /* closing anyway */
    }
  }
}, HEARTBEAT_MS)
heartbeat.unref()
wss.on('connection', (ws) => {
  ws.meboAlive = true
  ws.on('pong', () => (ws.meboAlive = true))
})

/**
 * Shutdown (a hosted instance stopping, or Ctrl+C). Every open conversation is
 * closed with 1012, "service restart", so the page reconnects at once to the
 * next instance instead of waiting for the host to cut it; in public mode the
 * durable memory writes in flight are finished first.
 */
let shuttingDown = false
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(heartbeat)
    for (const ws of wss.clients) {
      try {
        ws.close(1012, 'MeBo is restarting')
      } catch {
        /* already closing */
      }
    }
    void Promise.resolve(VISITORS?.flush()).finally(() => process.exit(0))
  })
}

const LOOPBACK = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost'
const bound = server.address()
console.log(
  `[mebo] bridge listening on ws://${bound.family === 'IPv6' ? `[${bound.address}]` : bound.address}:${bound.port}`,
)
if (!LOOPBACK) {
  console.warn(
    `[mebo] WARNING: listening on ${HOST}, not loopback — other machines on this network can reach the bridge`,
  )
}
console.log(
  `[mebo] speech ${elevenKey() ? 'via ElevenLabs (ELEVENLABS_API_KEY)' : 'using the local voice'}`,
)
console.log(`[mebo] model: ${PROVIDER.describe()}`)
if (PUBLIC) {
  console.log(
    `[mebo] PUBLIC mode: private memory per visitor (durable: ${DURABLE?.kind ?? 'none — lost on restart'}); ` +
      `limits ${LIMITS.visitorCalls} model calls and ${LIMITS.visitorWrites} writes per visitor per hour, ` +
      `${LIMITS.visitorConnections} connections per visitor, ${LIMITS.connections} in total`,
  )
}
if (DISABLED.size) console.log(`[mebo] disabled: ${[...DISABLED].join(', ')}`)
console.log(
  DISABLED.has('medical')
    ? '[mebo] medical tools: disabled'
    : `[mebo] medical tools (mebo_medical): ${MEDICAL_TOOLS_OFFERED.join(', ')}`,
)
console.log(
  '[mebo] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'I have answered as many questions as I may for now. Please try again later.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

// Public mode: a browser connecting without a visitor id gets one on the handshake.
wss.on('headers', (headers, req) => {
  if (!PUBLIC || visitorIdOf(req)) return
  req.meboVisitor = newVisitorId()
  headers.push(`Set-Cookie: ${visitorCookie(req.meboVisitor, { secure: COOKIE_SECURE })}`)
})

wss.on('connection', (socket, req) => {
  const visitor = PUBLIC ? (req.meboVisitor ?? visitorIdOf(req)) : null
  if (PUBLIC && !openSockets.acquire(visitor)) {
    console.warn('[mebo] refused a connection: too many open conversations')
    socket.close(1013, 'MeBo is busy. Please try again shortly.')
    return
  }
  console.log('[mebo] client connected')
  if (codeChangedSinceStart()) {
    console.warn(
      '[mebo] WARNING: the bridge code has changed since this process started, so it is not running ' +
        'the code on disk (tools, prompt or rules may be missing). Restart it: npm start.',
    )
  }

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({ type: 'ready', servers: DISABLED.has('medical') ? [] : ['mebo_medical'] }),
  )

  /** Resolves the pending user message into the SDK's input generator. */
  let deliver = null
  let closed = false
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  /**
   * Which question a deliberate interrupt is cancelling.
   *
   * The SDK has no 'cancelled' result subtype — an interrupted turn comes back
   * as error_during_execution, identical at the result to a turn that genuinely
   * broke. Recording what was cancelled tells the two apart, so a barge-in
   * stops announcing a failure that did not happen. Held as the id rather than
   * a bare flag because an interrupt that arrives with no turn in flight would
   * otherwise leave the flag standing and swallow the next real failure.
   */
  let cancelledAsk = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    if (decideTool(name)) return sendTurn({ type: 'tool', name })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name })
  }

  const session = createAgentSession({
        provider: PROVIDER,
        systemPrompt: LLM_SYSTEM_PROMPT,
        // The medical tools and the guided camera check.
        tools: DISABLED.has('medical')
          ? []
          : medicalTools(() => medicalServiceFor(visitor), {
              onActivity: (activity) => send({ type: 'medical', activity }),
              askPage: DISABLED.has('camera') ? undefined : ask,
            }),
        prompt: userMessages(),
        // Each visitor's own hourly budget of model calls (public mode).
        spend: PUBLIC
          ? () => {
              if (!visitorCalls.take(visitor)) {
                throw Object.assign(new Error('visitor model call limit reached'), { budget: true })
              }
            }
          : undefined,
      })

  // Pump the session's output stream to the browser for as long as it lives.
  ;(async () => {
    try {
      for await (const msg of session) {
        if (setting('DEBUG') === '1') {
          console.log(
            '[msg]',
            msg.type,
            msg.event?.type ?? '',
            msg.type === 'result' ? `subtype=${msg.subtype} result=${JSON.stringify(msg.result)}` : '',
            msg.type === 'assistant' ? JSON.stringify(msg.message?.content ?? msg.content) : '',
            msg.type === 'system' && msg.subtype === 'init' ? JSON.stringify(msg.mcp_servers) : '',
          )
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // MeBo goes completely mute.
          case 'stream_event': {
            const ev = msg.event
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text
            ) {
              sendTurn({ type: 'text', delta: ev.delta.text })
            }
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case 'result':
            // A result is not automatically a success. The error subtypes
            // carry no `result` field at all, so reporting them as 'done' with
            // empty text is indistinguishable from a turn that simply had
            // nothing to say — the HUD stops spinning and MeBo stands there
            // silent. Say what happened instead.
            if (msg.subtype === 'success') {
              sendTurn({
                type: 'done',
                text: msg.result ?? '',
                costUsd: msg.total_cost_usd ?? null,
              })
            } else if (cancelledAsk !== null && cancelledAsk === answering) {
              // Cancelled on purpose. The client bumps its turn counter before
              // interrupting, so it is already discarding anything tagged with
              // this id — sending an error would be a message nobody reads,
              // and logging one puts a failure in the log for a feature that
              // worked.
              console.log('[mebo] turn interrupted')
            } else {
              console.error(
                `[mebo] turn failed: ${msg.subtype}`,
                msg.errors ?? '',
              )
              sendTurn({
                type: 'error',
                message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
              })
            }
            cancelledAsk = null
            // Whatever was waiting on this turn to finish can go now. This is
            // the only place a turn is genuinely over.
            finishTurn?.()
            finishTurn = null
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            seenTools.clear()
            heldTools.clear()
            break

          case 'system':
            if (msg.subtype === 'init') {
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const usable = (msg.mcp_servers ?? [])
                .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                .map((s) => s.name)
              send({ type: 'ready', servers: usable })
              console.log(`[mebo] ${usable.length} MCP servers available`)
            }
            break
        }
      }
    } catch (err) {
      console.error('[mebo] session error:', err)
      send({ type: 'error', message: String(err?.message ?? err) })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      closed = true
      deliver?.(null)
      session.close?.()
      socket.close()
    }
  })()

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string' && msg.text.length > LIMITS.questionChars) {
      const id = typeof msg.id === 'string' ? msg.id : null
      send({ type: 'error', ask: id, message: 'That question is too long. Please ask it more briefly.' })
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       */
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      void settling.then(() => {
        answering = id
        if (deliver) {
          const resolve = deliver
          deliver = null
          resolve(text)
        } else {
          inbox.push(text)
        }
      })
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    if (msg.type === 'interrupt') {
      // Marks the turn in flight as cancelled on purpose, so the failed result
      // it is about to produce is not reported as a fault.
      cancelledAsk = answering
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(session.interrupt?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    if (PUBLIC) openSockets.release(visitor)
    console.log('[mebo] client disconnected')
    closed = true
    deliver?.(null)
    session.close?.()
  })
})
