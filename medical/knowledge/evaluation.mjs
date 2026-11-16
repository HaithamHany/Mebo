/**
 * The retrieval evaluation: the evidence for how MeBo searches its NASA/CSA
 * library, and for why it does not use vector search.
 *
 * Each positive question lists the passages that would be an acceptable
 * answer (id prefixes); retrieval passes when one of them is in the top 3.
 * Negative questions are ones the five sources do not answer; retrieval
 * passes when it reports no evidence instead of returning something.
 *
 * Run by test/knowledge.test.mjs, and printed by
 *   npm run medical -- knowledge-eval
 */

export const POSITIVE = [
  // The five topics MeBo must be able to explain.
  { topic: 'microgravity', q: 'How does microgravity affect the heart?', accept: ['S2:risk-of-cardiovascular-adaptations'] },
  { topic: 'microgravity', q: 'What happens to bones in weightlessness?', accept: ['S2:risk-of-spaceflight-induced-bone-changes'] },
  { topic: 'microgravity', q: 'How does zero gravity change the body?', accept: ['S1:gravity-fields'] },
  { topic: 'radiation', q: 'What does space radiation do to astronauts?', accept: ['S1:space-radiation', 'S2:risk-of-radiation-induced-cancers', 'S4:'] },
  { topic: 'radiation', q: 'Why are neutrons dangerous?', accept: ['S4:monitoring-radiation-for-astronaut-health-2'] },
  { topic: 'isolation', q: 'How does isolation affect the crew?', accept: ['S1:isolation-and-confinement', 'S2:risk-of-behavioral-changes'] },
  { topic: 'isolation', q: 'Can loneliness affect mental health on a long mission?', accept: ['S2:risk-of-behavioral-changes', 'S1:isolation-and-confinement'] },
  { topic: 'sleep', q: 'Why is sleep a problem in space?', accept: ['S2:risk-of-inadequate-sleep'] },
  { topic: 'sleep', q: 'How is the circadian rhythm disrupted on a mission?', accept: ['S2:risk-of-inadequate-sleep'] },
  { topic: 'distance', q: 'Why does distance from Earth matter for medical care?', accept: ['S1:distance-from-earth'] },
  { topic: 'distance', q: 'How long would a trip to Mars take?', accept: ['S1:distance-from-earth-2'] },
  // Other content the sources cover.
  { topic: 'exercise', q: 'How do astronauts exercise without a treadmill?', accept: ['S3:zero-t2', 'S2:risk-of-reduced-cardiorespiratory'] },
  { topic: 'research', q: 'What is ARCHeR?', accept: ['S3:archer'] },
  { topic: 'vision', q: 'How does spaceflight change the eyes?', accept: ['S2:risk-of-spaceflight-associated-neuro', 'S3:b-complex', 'S3:brain-fluid-pressure', 'S3:spinal-fluid'] },
  { topic: 'research', q: 'Why do we do science experiments on the space station?', accept: ['S5:'] },
]

export const NEGATIVE = [
  'How do I treat a broken arm?',
  'What is the recommended dose of ibuprofen?',
  'What are the best pizza toppings?',
  'Tell me about astronaut health',
  'What is the boiling point of water?',
]

export function evaluateRetrieval(kb, k = 3) {
  const misses = []
  let hit = 0
  for (const p of POSITIVE) {
    const ids = kb.search(p.q, { limit: k }).results.map((r) => r.passage_id)
    if (ids.some((id) => p.accept.some((a) => id.startsWith(a)))) hit++
    else misses.push({ q: p.q, got: ids })
  }
  const falseHits = []
  let rejected = 0
  for (const q of NEGATIVE) {
    const r = kb.search(q, { limit: k })
    if (!r.found) rejected++
    else falseHits.push({ q, got: r.results.map((x) => x.passage_id) })
  }
  return {
    recall_at_k: hit / POSITIVE.length,
    k,
    positives: POSITIVE.length,
    negative_rejection: rejected / NEGATIVE.length,
    negatives: NEGATIVE.length,
    misses,
    false_hits: falseHits,
  }
}
