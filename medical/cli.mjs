/**
 * The medical data service as a command-line tool. Output is JSON, so any
 * agent — Claude today, an offline model through Ollama later — or a script
 * can call it without a server or a model in the loop.
 *
 *   npm run medical -- seed [--force]          create / regenerate the synthetic dataset
 *   npm run medical -- provenance              versions, seed, checksum, references
 *   npm run medical -- mission
 *   npm run medical -- crew
 *   npm run medical -- metrics
 *   npm run medical -- summary <crew-id>
 *   npm run medical -- history <crew-id> <metric> [days]
 *   npm run medical -- trend <crew-id> <metric> [days]
 *   npm run medical -- questions <crew-id> <cardiovascular|sleep_fatigue>
 *   npm run medical -- assess <crew-id> <cardiovascular|sleep_fatigue> ['{"chest_pain":"no",…}']
 *   npm run medical -- tools                   tool definitions (JSON Schema)
 *   npm run medical -- tool <name> '{"crew_id":"ms2",…}'
 *   npm run medical -- knowledge "how does microgravity affect the heart"
 *   npm run medical -- knowledge-sources       the NASA/CSA snapshot
 *   npm run medical -- knowledge-eval          the retrieval evaluation
 *   npm run medical -- memory <crew-id>        conversational memory (Step 23)
 *
 * Every command runs offline, with no model involved.
 */

import { createMedicalService, MedicalError } from './service.mjs'
import { isSeeded, openDatabase, seed } from './db.mjs'
import { DEFAULT_DB_PATH } from './service.mjs'
import { assess, questions } from './cds/index.mjs'
import { callTool, toolDefinitions } from './tools.mjs'
import { createKnowledgeBase, knowledgeBase } from './knowledge/search.mjs'
import { evaluateRetrieval } from './knowledge/evaluation.mjs'
import { memoryOf } from './workflows.mjs'

const [cmd, ...args] = process.argv.slice(2)
const print = (x) => console.log(JSON.stringify(x, null, 2))
const days = (v) => (v === undefined ? undefined : Number(v))
const json = (v) => {
  if (v === undefined) return {}
  try {
    return JSON.parse(v)
  } catch {
    throw new MedicalError(400, `not valid JSON: ${v}`)
  }
}

try {
  if (cmd === 'seed') {
    const db = await openDatabase(DEFAULT_DB_PATH)
    if (isSeeded(db) && !args.includes('--force')) {
      console.log(`Already seeded: ${DEFAULT_DB_PATH} (use --force to regenerate the synthetic data).`)
    } else {
      const n = seed(db)
      console.log(`Wrote ${n} synthetic observations to ${DEFAULT_DB_PATH}`)
    }
    db.close()
  } else {
    const s = await createMedicalService()
    const run = {
      provenance: () => {
        const p = s.provenance()
        // The full scenario is long; `provenance --full` prints it.
        return args.includes('--full') ? p : { ...p, scenario: p.scenario && { id: p.scenario.id, seed: p.scenario.seed } }
      },
      mission: () => s.mission(),
      crew: () => s.crew(),
      metrics: () => s.metrics(),
      summary: () => s.summary(args[0]),
      history: () => s.history(args[0], args[1], { days: days(args[2]) }),
      trend: () => s.trend(args[0], args[1], { days: days(args[2]) ?? 30 }),
      questions: () => questions(s, args[0], args[1]),
      assess: () => assess(s, args[0], args[1], json(args[2])),
      tools: () => toolDefinitions(),
      tool: () => callTool(s, args[0], json(args[1])),
      knowledge: () => callTool(s, 'search_space_medical_knowledge', { query: args.join(' ') }),
      'knowledge-sources': () => knowledgeBase().sources(),
      memory: () => memoryOf(s).summary(args[0]),
      'knowledge-eval': () => ({
        mebo: evaluateRetrieval(createKnowledgeBase()),
        plain_fts: evaluateRetrieval(createKnowledgeBase({ concepts: [], gate: false })),
      }),
    }[cmd]
    if (!run) {
      console.error('usage: medical <seed|provenance|mission|crew|metrics|summary|history|trend|questions|assess|tools|tool|knowledge|knowledge-sources|knowledge-eval|memory> …')
      process.exitCode = 2
    } else {
      print(run())
    }
    s.close()
  }
} catch (err) {
  console.error(err instanceof MedicalError ? err.message : err)
  process.exitCode = 1
}
