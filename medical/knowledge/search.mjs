/**
 * Offline retrieval over MeBo's NASA/CSA knowledge snapshot.
 *
 * SQLite FTS5 (BM25 ranking, Porter stemming), in memory, built from the
 * committed corpus.json at first use. No network, no model, no embedding:
 * the same question always returns the same passages. Vector search was
 * evaluated against this and not adopted — see docs/nasa-resource-traceability.md
 * §4 for the retrieval evaluation.
 *
 * Two things make plain keyword search work on a 69-passage corpus:
 *   - CONCEPTS: a small, documented synonym map, because NASA writes
 *     "weightlessness" where a crew member says "microgravity".
 *   - The evidence gate: a passage counts only if it covers at least half of
 *     the question's specific concepts. Generic words ("astronaut", "health",
 *     "space") never count. A question the sources do not cover returns
 *     found: false — never the least-bad passage.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// MEBO_KNOWLEDGE_CORPUS lets a bundled deploy point at the file wherever the host put it.
export const CORPUS_PATH = process.env.MEBO_KNOWLEDGE_CORPUS || fileURLToPath(new URL('./corpus.json', import.meta.url))

export const KNOWLEDGE_NOTICE =
  'NASA/CSA background information, quoted from the source pages. It is not clinical guidance, sets no ' +
  'thresholds, and does not change any assessment.'

/**
 * Concept groups: a query term matching any member searches for all of them.
 * Hand-written and deliberately small; each group exists because a test
 * question needed it (see the retrieval evaluation).
 */
export const CONCEPTS = [
  ['microgravity', 'weightlessness', 'weightless', 'zero gravity', 'gravity', 'gravities'],
  ['heart', 'cardiovascular', 'circulation', 'blood vessels'],
  ['radiation', 'neutron', 'dose', 'exposure'],
  ['isolation', 'isolated', 'confinement', 'confined', 'lonely', 'loneliness'],
  ['sleep', 'sleeping', 'insomnia', 'fatigue', 'tired', 'circadian rhythm', 'circadian', 'biological clocks'],
  ['distance', 'far', 'communication delay', 'self-sufficiency', 'mars'],
  ['mental', 'mood', 'psychological', 'behavioral', 'behavioural', 'psychiatric', 'stress', 'stressors'],
  ['bone', 'bones', 'skeleton', 'osteoporosis'],
  ['muscle', 'muscles', 'musculoskeletal'],
  ['exercise', 'fitness', 'treadmill', 'workout'],
  ['eye', 'eyes', 'vision', 'neuro-ocular'],
  ['immune', 'immunity', 'viruses', 'infection'],
]

/** Never a concept on their own: they are in nearly every passage. */
const GENERIC = new Set(
  ('astronaut astronauts space spaceflight flight health healthy nasa csa crew crews mission missions human ' +
    'humans body bodies people effect effects affect affects impact impacts risk risks hazard hazards ' +
    'research study studies').split(' '),
)

const STOP = new Set(
  ('a an the and or but of to in on at by for with from is are was were be been being it its this that these ' +
    'those i you he she we they me my your our their what which who how why when where do does did can could ' +
    'would should will shall not no yes if then than as about into over under out up down there here just very ' +
    'tell explain me please mebo much many some any more most such').split(' '),
)

const tokens = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean)

/** Quote a term for FTS5 so user text can never be read as query syntax. */
const quote = (t) => `"${t.replace(/"/g, '')}"`

/**
 * The question's specific concepts. Multi-word group members ("zero
 * gravity") are matched against the whole question first.
 */
export function conceptsOf(query, groups = CONCEPTS) {
  const lower = ` ${tokens(query).join(' ')} `
  const used = new Set()
  const concepts = []
  for (const group of groups) {
    const hit = group.find((m) => lower.includes(` ${m} `))
    if (hit) {
      concepts.push({ term: hit, terms: group })
      for (const w of hit.split(' ')) used.add(w)
    }
  }
  for (const t of tokens(query)) {
    if (used.has(t) || STOP.has(t) || GENERIC.has(t) || t.length < 3) continue
    used.add(t)
    concepts.push({ term: t, terms: [t] })
  }
  return concepts
}

export function loadCorpus(path = CORPUS_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Build a knowledge base. Synchronous, so the clinical engine can attach
 * background without becoming async; `node:sqlite` is loaded through
 * process.getBuiltinModule (Node 22.3+). On an older Node it throws, and
 * callers report the knowledge base as unavailable.
 */
export function createKnowledgeBase({ corpus = loadCorpus(), concepts: groups = CONCEPTS, gate = true } = {}) {
  const sqlite = process.getBuiltinModule?.('node:sqlite')
  if (!sqlite) throw new Error(`The knowledge base needs Node 22.13 or newer (node:sqlite); this is Node ${process.versions.node}.`)
  const db = new sqlite.DatabaseSync(':memory:')
  db.exec(
    "CREATE VIRTUAL TABLE passages USING fts5(passage_id UNINDEXED, source_id UNINDEXED, section, body, tokenize='porter unicode61')",
  )
  const insert = db.prepare('INSERT INTO passages (passage_id, source_id, section, body) VALUES (?, ?, ?, ?)')
  const byId = new Map()
  const sources = new Map()
  for (const s of corpus.sources) {
    sources.set(s.id, s)
    for (const p of s.passages) {
      insert.run(p.id, s.id, p.section, p.text)
      byId.set(p.id, { ...p, source_id: s.id })
    }
  }
  // Section headings weigh double: "Risk of Cardiovascular Adaptations" is a
  // stronger signal than a passing mention in body text.
  const rank = db.prepare(
    'SELECT passage_id, bm25(passages, 0, 0, 2.0, 1.0) AS score FROM passages WHERE passages MATCH ? ORDER BY score LIMIT 25',
  )
  const covers = db.prepare('SELECT 1 FROM passages WHERE passage_id = ? AND passages MATCH ?')

  const cite = (passageId, extra = {}) => {
    const p = byId.get(passageId)
    const s = sources.get(p.source_id)
    const date = s.dates?.last_updated
      ? `page last updated ${s.dates.last_updated}`
      : s.dates?.modified
        ? `page modified ${s.dates.modified}`
        : s.dates?.published
          ? `published ${s.dates.published}`
          : 'date not stated'
    return {
      passage_id: p.id,
      source_id: s.id,
      publisher: s.publisher,
      title: s.title,
      section: p.section,
      url: s.url,
      dates: s.dates,
      retrieved_at: s.retrieved_at,
      text: p.text,
      citation: `${s.publisher}, "${s.title.replace(/ [-|] (NASA|Canadian Space Agency)$/, '')}", section "${p.section}", ${date}, ${s.url} (retrieved ${s.retrieved_at.slice(0, 10)})`,
      ...extra,
    }
  }

  return {
    sources: () =>
      [...sources.values()].map((s) => ({
        id: s.id, publisher: s.publisher, title: s.title, url: s.url, dates: s.dates,
        retrieved_at: s.retrieved_at, passages: s.passages.length, text_sha256: s.text_sha256,
      })),

    passage: (id) => (byId.has(id) ? cite(id) : null),

    /**
     * @returns {{ found, query, concepts, results, message? }}
     */
    search(query, { limit = 3, sourceIds = null } = {}) {
      const concepts = conceptsOf(String(query ?? ''), groups)
      const base = { notice: KNOWLEDGE_NOTICE, query, concepts: concepts.map((c) => c.term) }
      if (!concepts.length) {
        return { ...base, found: false, results: [], message: 'The question names nothing specific to look up.' }
      }
      const expr = concepts.flatMap((c) => c.terms).map(quote).join(' OR ')
      // `gate: false` is the plain-FTS baseline used by the retrieval evaluation.
      const need = gate ? Math.max(1, Math.ceil(concepts.length / 2)) : 0
      const results = []
      for (const row of rank.all(expr)) {
        const p = byId.get(row.passage_id)
        if (sourceIds && !sourceIds.includes(p.source_id)) continue
        const matched = concepts.filter((c) => covers.get(p.id, c.terms.map(quote).join(' OR ')))
        if (matched.length < need) continue
        results.push(cite(p.id, { score: Math.round(-row.score * 1000) / 1000, matched_concepts: matched.map((c) => c.term) }))
        if (results.length >= limit) break
      }
      return results.length
        ? { ...base, found: true, results }
        : {
            ...base,
            found: false,
            results: [],
            message: 'No passage in the NASA/CSA library covers this question. Say so rather than answering from general knowledge.',
          }
    },

    close: () => db.close(),
  }
}

let shared = null
/** The process-wide knowledge base, built on first use. */
export function knowledgeBase() {
  shared ??= createKnowledgeBase()
  return shared
}
