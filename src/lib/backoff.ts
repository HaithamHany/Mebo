/**
 * Retry timing for the two things that reconnect on their own: the bridge
 * socket (bridge.ts) and speech recognition (voice.ts). Pure, so it can be
 * tested without a browser.
 */

/**
 * Delay before re-dialling the bridge, by attempt number and the close code.
 * A hosted bridge closes connections routinely — at the host's
 * connection-length limit, on a restart (1012), when it is busy (1013) — so
 * the page keeps trying, with the wait capped at half a minute.
 */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, 15000, 30000]
export function reconnectDelay(attempt: number, closeCode?: number): number {
  if (closeCode === 1012) return attempt === 0 ? 0 : 1000
  const base = RECONNECT_DELAYS[Math.min(Math.max(0, attempt), RECONNECT_DELAYS.length - 1)]
  return closeCode === 1013 ? Math.max(base, 5000) : base
}

/**
 * Delay before restarting speech recognition after `failures` failed sessions
 * in a row: 80 ms normally, doubling with each failure, at most five seconds.
 */
export const restartDelay = (failures: number) => (failures <= 0 ? 80 : Math.min(5000, 80 * 2 ** failures))
