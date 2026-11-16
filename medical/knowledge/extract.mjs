/**
 * Turn a retrieved NASA or CSA page into plain-text sections.
 *
 * Dependency-free on purpose: the pages are simple, and an HTML parser would
 * be the only reason to add a package to the medical layer. Only the article
 * body is kept (NASA: `.entry-content`; CSA: `<main>`), split at headings,
 * with scripts, styles, navigation and forms removed, and image descriptions
 * kept. Text is kept verbatim: nothing is paraphrased or summarised, so
 * every passage MeBo cites is the agency's own wording.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' }

export function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

const clean = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

/** The slice of the page that is the article. */
function articleOf(html, site) {
  if (site === 'nasa') {
    const start = html.indexOf('class="entry-content"')
    if (start < 0) throw new Error('NASA page: .entry-content not found')
    // The article ends where the page footer metadata begins.
    const end = html.indexOf('hds-footer-meta', start)
    return html.slice(start, end > 0 ? end : undefined)
  }
  const m = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html)
  if (!m) throw new Error('CSA page: <main> not found')
  // CSA pages end <main> with "Date modified" and page-feedback blocks.
  return m[1].split(/<section[^>]+class="[^"]*pagedetails/i)[0]
}

/**
 * @returns {{ heading: string, text: string }[]} sections in page order. The
 *   first section's heading is the page title when the article has none.
 */
export function extractSections(html, site, title) {
  // Figures are kept: their image descriptions are agency text (see below).
  // Site chrome under its own headings is dropped later, by heading.
  const body = articleOf(html, site).replace(/<(script|style|noscript|svg|form|nav|button|iframe)[\s\S]*?<\/\1>/gi, ' ')

  const sections = []
  let current = { heading: title, parts: [] }
  // Image descriptions are the agency's own words and sometimes carry facts
  // the prose does not (S3's ARCHeR card describes the wrist-worn actigraphy
  // device only in its image text). On NASA's cards the image comes before
  // its heading, so a description waits and joins the section of the next
  // paragraph rather than the one it happens to follow.
  let pendingAlts = []
  const re = /<(h[1-4])[^>]*>([\s\S]*?)<\/\1>|<(p|li)[^>]*>([\s\S]*?)<\/\3>|<img\b[^>]*\balt="([^"]{40,})"/gi
  for (let m; (m = re.exec(body)); ) {
    if (m[1]) {
      const h = clean(m[2])
      if (!h) continue
      if (current.parts.length) sections.push(current)
      current = { heading: h, parts: [] }
    } else if (m[5]) {
      // A description has words; a bare file name ("chris_cassidy_fresh_fruit_main") does not.
      const alt = clean(m[5])
      if (/\s/.test(alt)) pendingAlts.push(`Image description: ${alt}`)
    } else {
      const t = clean(m[4])
      if (t.length > 1) {
        current.parts.push(...pendingAlts, t)
        pendingAlts = []
      }
    }
  }
  if (current.parts.length) sections.push(current)
  return sections.map((s) => ({ heading: s.heading, text: s.parts.join('\n') }))
}

/** Target passage size, in words. Long sections split at paragraph breaks. */
export const PASSAGE_WORDS = 90

/** Split sections into passages of whole paragraphs, about PASSAGE_WORDS long. */
export function toPassages(sections) {
  const out = []
  for (const s of sections) {
    let buf = []
    let words = 0
    const flush = () => {
      if (buf.length) out.push({ section: s.heading, text: buf.join('\n') })
      buf = []
      words = 0
    }
    for (const para of s.text.split('\n')) {
      const w = para.split(/\s+/).length
      if (words && words + w > PASSAGE_WORDS) flush()
      buf.push(para)
      words += w
    }
    flush()
  }
  return out
}

/** Page dates, recorded with where they came from. */
export function pageDates(html, site) {
  if (site === 'csa') {
    const meta = (name) => new RegExp(`<meta name="dcterms\\.${name}"[^>]*content="([^"]+)"`).exec(html)?.[1] ?? null
    return { published: meta('issued'), modified: meta('modified'), basis: 'dcterms.issued / dcterms.modified meta tags' }
  }
  const ld = (k) => new RegExp(`"${k}":"([^"]+)"`).exec(html)?.[1] ?? null
  const footer = /Page Last Updated:\s*<\/div>\s*<div class="hds-footer-meta-value">\s*([^<]+?)\s*<\/div>/.exec(html)?.[1] ?? null
  return {
    published: ld('datePublished'),
    modified: ld('dateModified'),
    last_updated: footer,
    basis: 'JSON-LD datePublished/dateModified where present; "Page Last Updated" footer',
  }
}

export function pageTitle(html) {
  return decode(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '').trim()
}
