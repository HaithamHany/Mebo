/**
 * Refresh MeBo's NASA/CSA knowledge snapshot.
 *
 *   npm run knowledge:fetch
 *
 * Downloads the five official pages, extracts the article text verbatim,
 * splits it into passages, and writes medical/knowledge/corpus.json with each
 * source's URL, title, publisher, page dates, retrieval time and content
 * hashes. The snapshot is committed: MeBo never fetches at run time, so
 * retrieval works fully offline. A source that cannot be fetched keeps its
 * previous snapshot and is reported, never silently dropped.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { KNOWLEDGE_SOURCES, BOILERPLATE_HEADINGS } from '../medical/knowledge/sources.mjs'
import { extractSections, pageDates, pageTitle, toPassages } from '../medical/knowledge/extract.mjs'

const OUT = fileURLToPath(new URL('../medical/knowledge/corpus.json', import.meta.url))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36'
const sha = (s) => createHash('sha256').update(s).digest('hex')
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)

async function download(url) {
  let last
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      // The CSA server resets connections intermittently; patience fixes it.
      last = err
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw last
}

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { sources: [] }
const sources = []
const failures = []

for (const src of KNOWLEDGE_SOURCES) {
  try {
    const html = await download(src.url)
    const title = pageTitle(html)
    const sections = extractSections(html, src.site, title).filter((s) => !BOILERPLATE_HEADINGS.has(s.heading))
    const seen = new Map()
    const passages = toPassages(sections).map((p) => {
      const base = `${src.id}:${slug(p.section)}`
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      return { id: n === 1 ? base : `${base}-${n}`, section: p.section, text: p.text }
    })
    if (!passages.length) throw new Error('no article text extracted')
    sources.push({
      ...src,
      title,
      dates: pageDates(html, src.site),
      retrieved_at: new Date().toISOString(),
      html_sha256: sha(html),
      text_sha256: sha(passages.map((p) => p.text).join('\n')),
      passages,
    })
    console.log(`  ${src.id} ok · ${passages.length} passages · ${title}`)
  } catch (err) {
    const kept = previous.sources.find((s) => s.id === src.id)
    failures.push({ id: src.id, url: src.url, error: String(err?.message ?? err), kept_previous_snapshot: Boolean(kept) })
    if (kept) sources.push(kept)
    console.warn(`  ${src.id} FAILED (${err?.message ?? err})${kept ? ' — keeping the previous snapshot' : ''}`)
  }
}

writeFileSync(
  OUT,
  JSON.stringify({ schema: 1, generated_at: new Date().toISOString(), failures, sources }, null, 2) + '\n',
)
console.log(`wrote ${OUT}`)
process.exitCode = failures.length ? 1 : 0
