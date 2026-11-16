/**
 * Public mode (MEBO_PUBLIC=1): what changes when MeBo is reachable by
 * strangers, as on a Netlify deploy.
 *
 *   Visitors      Each browser gets a random visitor id in an HttpOnly,
 *                 SameSite=Strict cookie, issued by the bridge. Every visitor
 *                 has a private crew memory: one visitor's answers,
 *                 assessments, camera observations and fatigue concerns are
 *                 never visible to another. The synthetic medical database is
 *                 read-only and shared.
 *   Durability    Crew memory is written to local files as always, and each
 *                 write is copied to a durable store under the visitor's
 *                 prefix. A visitor's files are restored from it the first
 *                 time they are needed on a fresh instance.
 *   Limits        Enforced here, server-side, whatever the page does: model
 *                 calls per visitor per hour, connections per visitor and in
 *                 total, and medical API writes per visitor per hour.
 *
 * Local use (MEBO_PUBLIC unset) is unchanged: one shared memory, no cookie.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// --- visitor identity -------------------------------------------------------------

export const VISITOR_COOKIE = 'mebo_visitor'
const VISITOR_ID = /^[a-f0-9]{32}$/
const COOKIE_MAX_AGE_S = 30 * 24 * 3600

export const newVisitorId = () => randomBytes(16).toString('hex')

/** The visitor id from a request's cookies, or null if there is no valid one. */
export function visitorIdOf(req) {
  const header = req?.headers?.cookie
  if (typeof header !== 'string') return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0 || part.slice(0, i).trim() !== VISITOR_COOKIE) continue
    const v = part.slice(i + 1).trim()
    return VISITOR_ID.test(v) ? v : null
  }
  return null
}

/** Set-Cookie value for a visitor id. Secure unless the bridge is plain-HTTP local. */
export function visitorCookie(id, { secure = true } = {}) {
  return `${VISITOR_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? '; Secure' : ''}`
}

// --- limits -------------------------------------------------------------------------

/** A sliding one-hour window per key. `take(key)` is false once the key has used `perHour`. */
export function hourlyLimiter(perHour, { now = Date.now } = {}) {
  const hits = new Map()
  return {
    perHour,
    take(key) {
      const t = now()
      const list = (hits.get(key) ?? []).filter((x) => t - x < 3_600_000)
      if (list.length >= perHour) {
        hits.set(key, list)
        return false
      }
      list.push(t)
      hits.set(key, list)
      // Forget idle keys now and then, so the map cannot grow without bound.
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < 3_600_000)) hits.delete(k)
      return true
    },
  }
}

/** Open connections per key, with a per-key and a total ceiling. */
export function connectionLimiter({ perKey, total }) {
  const open = new Map()
  let all = 0
  return {
    acquire(key) {
      if (all >= total || (open.get(key) ?? 0) >= perKey) return false
      open.set(key, (open.get(key) ?? 0) + 1)
      all++
      return true
    },
    release(key) {
      const n = open.get(key) ?? 0
      if (n <= 1) open.delete(key)
      else open.set(key, n - 1)
      all = Math.max(0, all - 1)
    },
  }
}

// --- durable store ----------------------------------------------------------------------

/**
 * The durable copy of crew memory, from MEBO_DURABLE_MEMORY:
 *   netlify-blobs   Netlify Blobs (store "mebo-crew-memory", strong consistency)
 *   dir:<path>      a folder (self-hosting on a persistent disk, and tests)
 *   unset           none: local files only
 * Each adapter: list(prefix) → keys, get(key) → text|null, set(key, text).
 */
export async function durableStoreFromEnv(spec = process.env.MEBO_DURABLE_MEMORY) {
  if (!spec) return null
  if (spec === 'netlify-blobs') {
    const { getStore } = await import('@netlify/blobs')
    const store = getStore({ name: 'mebo-crew-memory', consistency: 'strong' })
    return {
      kind: 'netlify-blobs',
      async list(prefix) {
        const { blobs } = await store.list({ prefix })
        return blobs.map((b) => b.key)
      },
      get: (key) => store.get(key, { type: 'text' }),
      set: (key, text) => store.set(key, text),
    }
  }
  if (spec.startsWith('dir:')) {
    const root = spec.slice(4)
    const pathOf = (key) => join(root, ...key.split('/'))
    return {
      kind: 'dir',
      async list(prefix) {
        const [visitor] = prefix.split('/')
        try {
          return readdirSync(join(root, visitor)).filter((f) => f.endsWith('.json')).map((f) => `${visitor}/${f}`)
        } catch {
          return []
        }
      },
      async get(key) {
        try {
          return readFileSync(pathOf(key), 'utf8')
        } catch {
          return null
        }
      },
      async set(key, text) {
        mkdirSync(join(pathOf(key), '..'), { recursive: true })
        writeFileSync(pathOf(key), text)
      },
    }
  }
  throw new Error(`MEBO_DURABLE_MEMORY must be netlify-blobs or dir:<path>, not "${spec}"`)
}

// --- per-visitor medical services -----------------------------------------------------

/**
 * One medical service per visitor, each with its own memory folder under
 * `memoryRoot`, all reading the same database file. Kept for the most recent
 * `max` visitors; older ones are closed (their memory stays on disk and in
 * the durable store).
 *
 * @param o.createService  (opts) → service, i.e. createMedicalService
 * @param o.dbPath         the shared database file
 * @param o.memoryRoot     folder for per-visitor memory
 * @param o.durable        adapter from durableStoreFromEnv, or null
 */
export function visitorServices({ createService, dbPath, memoryRoot, durable, max = 200, log = console }) {
  const cache = new Map() // visitor → Promise<service>, oldest first

  // Writes are copied in order per key; a failure is logged and retried once.
  const pending = new Map()
  const persist = (key, text) => {
    const prev = pending.get(key) ?? Promise.resolve()
    const next = prev
      .then(() => durable.set(key, text))
      .catch(async () => {
        try {
          await durable.set(key, text)
        } catch (err) {
          log.error?.(`[mebo] could not save crew memory durably (${key.split('/')[1]}): ${err?.message ?? err}`)
        }
      })
    pending.set(key, next)
    void next.finally(() => pending.get(key) === next && pending.delete(key))
  }

  async function open(visitor) {
    const dir = join(memoryRoot, visitor)
    mkdirSync(dir, { recursive: true })
    if (durable) {
      // Restore this visitor's files from the durable copy — only those not
      // already here, since a local file (an evicted, reopened visitor) is
      // never older than its durable copy.
      for (const key of await durable.list(`${visitor}/`)) {
        const name = key.split('/').pop()
        if (!/^[a-z0-9_-]+\.json$/i.test(name) || existsSync(join(dir, name))) continue
        const text = await durable.get(key)
        if (text) writeFileSync(join(dir, name), text)
      }
    }
    return createService({
      path: dbPath,
      memoryDir: dir,
      ...(durable ? { onMemorySave: (crewId, json) => persist(`${visitor}/${crewId}.json`, json) } : {}),
    })
  }

  return {
    /** The visitor's service, opened (and restored) on first use. */
    serviceFor(visitor) {
      if (!VISITOR_ID.test(visitor ?? '')) return Promise.reject(Object.assign(new Error('no visitor id'), { status: 400 }))
      let p = cache.get(visitor)
      if (p) {
        // Most recently used goes to the end.
        cache.delete(visitor)
        cache.set(visitor, p)
        return p
      }
      p = open(visitor).catch((err) => {
        cache.delete(visitor)
        throw err
      })
      cache.set(visitor, p)
      while (cache.size > max) {
        const [oldest, svc] = cache.entries().next().value
        cache.delete(oldest)
        void svc.then((s) => s.close?.()).catch(() => {})
      }
      return p
    },
    /** Wait for every durable write in flight (shutdown, tests). */
    async flush() {
      await Promise.allSettled([...pending.values()])
    },
  }
}
