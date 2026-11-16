/**
 * MeBo on Netlify Server: the existing bridge (bridge/server.mjs), run as it
 * is, as the site's long-lived backend. The static app is served by the CDN;
 * everything else — the WebSocket at /ws, /health, /medical, /tts — reaches
 * this process.
 *
 * This file only maps Netlify's environment onto the bridge's settings, then
 * starts it. Anything already set in the site's environment wins.
 *
 * Hosted, MeBo runs in public mode: Hugging Face only (offline Ollama needs
 * the crew's own machine and stays a local feature), a private crew memory
 * per visitor kept durably in Netlify Blobs, and server-side limits
 * (bridge/public.mjs). Protect the site with Netlify password protection or
 * team login as well: the bridge has no accounts of its own.
 */

import { fileURLToPath } from 'node:url'

const env = process.env
const def = (name, value) => {
  if (env[name] === undefined || env[name] === '') env[name] = value
}

// The bridge listens where Netlify routes traffic, on every interface of the instance.
def('MEBO_BRIDGE_PORT', env.PORT ?? '8787')
def('MEBO_BRIDGE_HOST', '0.0.0.0')
def('MEBO_PUBLIC', '1')
def('LLM_PROVIDER', 'huggingface')
def('MEBO_DURABLE_MEMORY', 'netlify-blobs')

// Only /tmp is writable on an instance, and it is emptied when the instance
// stops: the database is rebuilt there (deterministic, about a quarter of a
// second) and memory is restored from Blobs.
def('MEBO_MEDICAL_DB', '/tmp/mebo-medical.sqlite')
def('MEBO_MEMORY_DIR', '/tmp/mebo-memory')
def('MEBO_WORKSPACE', '/tmp/mebo-workspace')

// The NASA/CSA library, shipped with the server (see config.includedFiles).
def('MEBO_KNOWLEDGE_CORPUS', fileURLToPath(new URL('../../medical/knowledge/corpus.json', import.meta.url)))

// The site's own hosts and origins: production, the branch or preview URL, and
// this deploy's permalink. The bridge refuses any other Host or Origin.
const sites = [env.URL, env.DEPLOY_PRIME_URL, env.DEPLOY_URL]
  .filter(Boolean)
  .map((u) => {
    try {
      return new URL(u)
    } catch {
      return null
    }
  })
  .filter(Boolean)
def('MEBO_ALLOWED_HOSTS', [...new Set(sites.map((u) => u.host))].join(','))
def('MEBO_ALLOWED_ORIGINS', [...new Set(sites.map((u) => u.origin))].join(','))

await import('../../bridge/server.mjs')

export const config = {
  // Data files the bridge reads at runtime, beside its code.
  includedFiles: ['../../medical/knowledge/corpus.json'],
}
