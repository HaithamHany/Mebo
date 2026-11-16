/**
 * The five official resources MeBo's knowledge base is built from — the
 * sources supplied with the NASA Space Apps 2026 challenge. Ids match
 * medical/references.mjs (S1–S5), so a passage and a rule citing the same
 * source agree on its name.
 */

export const KNOWLEDGE_SOURCES = [
  { id: 'S1', site: 'nasa', publisher: 'NASA Human Research Program', url: 'https://www.nasa.gov/hrp/hazards/' },
  { id: 'S2', site: 'nasa', publisher: 'NASA Human Research Program', url: 'https://www.nasa.gov/hrp/risks/' },
  { id: 'S3', site: 'nasa', publisher: 'NASA Human Research Program', url: 'https://www.nasa.gov/hrp/ongoing-hrp-research/' },
  {
    id: 'S4', site: 'csa', publisher: 'Canadian Space Agency',
    url: 'https://www.asc-csa.gc.ca/eng/news/articles/2026/2026-02-26-monitoring-radiation-astronaut-health.asp',
  },
  {
    id: 'S5', site: 'csa', publisher: 'Canadian Space Agency',
    url: 'https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp',
  },
]

/** Site chrome that ends up under a heading but is not the article. */
export const BOILERPLATE_HEADINGS = new Set([
  'Discover More Topics From NASA',
  'National Aeronautics and Space Administration',
  'Follow NASA',
  'Explore further',
  'Follow us',
])
