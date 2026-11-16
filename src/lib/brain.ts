import * as bridge from './bridge'
import type { AskHandlers } from './bridge'
import type { Blade, Panel } from '../store'

export type { AskHandlers }
export type { ConnectionState } from './bridge'

/** A conversation message, kept for callers that thread history. */
export type Msg = { role: 'user' | 'assistant'; content: string }

/**
 * The brain: the local bridge (bridge/server.mjs), which runs the language
 * model — Hugging Face or a local Ollama — with MeBo's medical tools, and
 * keeps the conversation for as long as the socket is open. Every credential
 * stays in the bridge; the browser holds none.
 */

export const usingBridge = true

/** Conversation state lives in the bridge session, so history is not sent. */
export async function ask(
  prompt: string,
  _history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  return bridge.ask(prompt, handlers)
}

export async function warm(): Promise<void> {
  await bridge.warmBridge()
}

/** The bridge reports its server list on connect, then again once the agent boots. */
export function watchServers(fn: (servers: string[]) => void): void {
  bridge.watchServers(fn)
}

/** HUD panels pushed mid-turn by the bridge. */
export function watchPanels(fn: (panel: Panel) => void): void {
  bridge.watchPanels(fn)
}

/** Blades — the big surface — arrive the same way. */
export function watchBlades(fn: (blade: Blade) => void): void {
  bridge.watchBlades(fn)
}

/** Interface commands pushed by the bridge. */
export function watchUi(fn: (op: string, args: any) => void): void {
  bridge.watchUi(fn)
}

/** Medical tool activity, for the Medical Agents panel. */
export function watchMedical(fn: (activity: Record<string, unknown>) => void): void {
  bridge.watchMedical(fn)
}

/** MeBo asking for the guided camera check. */
export function watchVisual(fn: (req: bridge.VisualRequest) => Promise<Record<string, unknown>>): void {
  bridge.watchVisual(fn)
}

/** The bridge asking the page for a camera frame. */
export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): void {
  bridge.watchCapture(fn)
}

/** Barge-in: stop the answer and settle the outstanding ask(). */
export function cancel(): void {
  bridge.cancel()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/** Whether the bridge socket is up. */
export function isConnected(): boolean {
  return bridge.isConnected()
}

/** Connection state, for the UI. The socket is the conversation. */
export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): void {
  bridge.watchConnection(fn)
}

/** Labels for the HUD's SYSTEMS rail. */
export function connectedLabels(): string[] {
  return bridge.bridgeServers()
}
