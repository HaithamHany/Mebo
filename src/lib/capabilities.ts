import { BACKEND, BRIDGE_HTTP_URL } from '../config'

/**
 * What speech engines are actually available, decided once at boot.
 *
 * The whole point is that the app runs for anyone. A student who has done
 * nothing but install Claude Code and log in gets the browser's own speech
 * recognition and voice — no keys, no accounts, it just works. A student who
 * also has an ElevenLabs key (in their Claude Code config or a .env) gets Scribe
 * transcription and the ElevenLabs voice instead, automatically, with no flag to
 * set. This module is how the rest of the app learns which of those two worlds
 * it is in, so voice.ts and tts.ts never have to guess.
 *
 * The premium paths both live behind the bridge — it holds the key and makes
 * the calls, so the browser never sees a secret. In direct mode (no bridge)
 * only a key baked into the bundle could reach ElevenLabs for speech, and that
 * is not a path worth encouraging, so direct mode is treated as browser-only.
 */

export type Capabilities = {
  /** ElevenLabs speech-to-text (Scribe) is reachable via the bridge. */
  stt: boolean
  /** ElevenLabs text-to-speech is reachable via the bridge. */
  tts: boolean
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
let current: Capabilities = { stt: false, tts: false }
let probed = false

/**
 * Whether the bridge that answered is running current code, as far as it can
 * tell us. null when there was no bridge to ask.
 *
 * `outdated` is true when the bridge reports its code changed after it
 * started, or when it does not report its medical tools at all — a bridge
 * older than that report is, by definition, older than this page. That is
 * the state in which MeBo has no medical tools and says it has no records.
 */
export type BridgeStatus = {
  outdated: boolean
  medicalTools: string[] | null
  /** The model the bridge runs, as its /health reports it (provider id and model id), or null. */
  llm: { provider: string; model: string } | null
}
let bridge: BridgeStatus | null = null
const bridgeListeners = new Set<() => void>()

export function bridgeStatus(): BridgeStatus | null {
  return bridge
}

/** Be told when the bridge status changes (a probe or a refresh). Returns the unsubscribe. */
export function onBridgeStatus(fn: () => void): () => void {
  bridgeListeners.add(fn)
  return () => bridgeListeners.delete(fn)
}

/** Read the bridge's /health. Updates and announces the bridge status; returns the raw report, or null. */
async function readHealth(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return null
    const h = (await res.json()) as {
      code_changed?: boolean
      medical_tools?: string[]
      llm?: { provider?: unknown; model?: unknown }
    }
    const tools = Array.isArray(h.medical_tools) ? h.medical_tools : null
    const llm =
      h.llm && typeof h.llm.provider === 'string' && typeof h.llm.model === 'string'
        ? { provider: h.llm.provider, model: h.llm.model }
        : null
    bridge = { outdated: h.code_changed === true || tools === null, medicalTools: tools, llm }
    for (const fn of bridgeListeners) fn()
    return h
  } catch {
    return null
  }
}

/**
 * Ask the bridge again what it runs — after a reconnect, when it may be a
 * restarted bridge on another provider. Never throws.
 */
export async function refreshBridgeStatus(): Promise<void> {
  await readHealth()
}

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved during boot. */
export function caps(): Capabilities {
  return current
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do, once. Called during the boot sequence, before
 * the voice loop starts, so the first "Hey MeBo" already uses the right
 * engine. Never throws: a failed probe simply leaves the browser fallback in
 * place, which is the correct behaviour when the bridge is unreachable.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  if (BACKEND !== 'bridge') {
    // No bridge to ask. Direct mode has no server-side speech, so browser only.
    current = { stt: false, tts: false }
    probed = true
    return current
  }
  // Bridge down or slow: stay on the browser engines rather than blocking
  // boot on a health check that is only an optimisation.
  const h = await readHealth()
  if (h) current = { stt: Boolean(h.stt), tts: Boolean(h.tts) }
  probed = true
  return current
}

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  if (c.stt && c.tts) return 'ElevenLabs'
  if (c.tts) return 'ElevenLabs voice'
  return 'browser speech'
}
