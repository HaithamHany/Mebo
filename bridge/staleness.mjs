/**
 * Is a running bridge executing the code that is on disk?
 *
 * Node loads the bridge once and never reloads it, while the page
 * hot-reloads — so after an edit the two can silently disagree. That is how
 * MeBo once answered "I do not have Novak's cardiovascular records" with the
 * medical tools fully written: the bridge serving it predated them.
 * `npm start` restarts the bridge on change; this catches every other way of
 * running it, and /health reports it.
 *
 * Only the bridge's own code counts: every file reachable from the entry
 * point through relative imports, static or dynamic. Scanning whole
 * directories was wrong — editing a tool the bridge never loads (the medical
 * CLI, the knowledge fetch script) reported it out of date when it was not.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+\.m?js)['"]/g

/** Every module reachable from `entry` through relative imports. */
export function moduleGraph(entry) {
  const seen = new Set()
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let src
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of src.matchAll(SPEC)) stack.push(join(file, '..', m[1]))
  }
  return [...seen]
}

/** Has any of these files changed (or gone) since `since` (ms)? */
export function changedSince(files, since) {
  for (const file of files) {
    try {
      if (statSync(file).mtimeMs > since) return true
    } catch {
      return true // a module that was loaded has gone
    }
  }
  return false
}
