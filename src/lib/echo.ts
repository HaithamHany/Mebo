/**
 * Hearing himself: the text-level echo filter.
 *
 * The microphone stays open while MeBo talks, so the recogniser transcribes
 * MeBo's own voice coming back through the speakers. These rules decide, from
 * the words alone, whether a transcript is that echo or the person speaking.
 * Kept free of browser and app imports so the rules can be tested directly
 * (test/voice-echo.test.mjs). Used by voice.ts.
 */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 */
export const OVERRIDE =
  /\b(stop|wait|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)\b/i

/**
 * His name cuts through too — calling him mid-answer is the natural way in —
 * but only while he is not saying it himself. MeBo never spoke his own name,
 * so an unconditional exemption was safe; MeBo introduces itself ("Hello. I am
 * MeBo…"), and with the name exempt the microphone would hear that, call it a
 * barge-in, and cut MeBo off mid-introduction — or, in standby, wake it.
 */
const NAMES = /\b(mebo|meebo|me bo|baymax|bay max)\b/i

/** Does this cut through regardless of the echo filter? */
export function overrides(heard: string, spoken: string): boolean {
  if (OVERRIDE.test(heard)) return true
  return NAMES.test(heard) && !NAMES.test(spoken)
}

/**
 * Words a person uses when answering about themselves, and that MeBo — who
 * speaks to the patient in the second person — rarely says.
 *
 * MeBo seldom asked questions; MeBo asks them constantly ("Do you have any
 * chest pain?", "Are you satisfied with your care?"), and the natural answer
 * repeats the question's own words: "I have chest pain", "I am satisfied with
 * my care". By word overlap alone those are indistinguishable from MeBo
 * hearing itself, and the filter threw away 20 of 31 such replies — the
 * microphone seemed to stop listening exactly when it was asked to. One of
 * these words, when MeBo did not just say it, is the person talking.
 */
const ANSWERING = new Set(
  "i i'm im i've i'd i'll my me mine myself am yes yeah yep yup nope nah not".split(' '),
)

/** The word an answering word stands for. The recogniser writes MeBo's own
 *  "I am" as "I'm" often enough that a contraction alone proves nothing. */
const rootOf = (w: string) =>
  /^i'?(?:m|ve|d|ll)$/.test(w) ? 'i' : /^(?:yeah|yep|yup)$/.test(w) ? 'yes' : w

/** Does the heard text contain an answering word that MeBo itself did not say? */
function answers(heard: string[], spoken: Set<string>): boolean {
  const said = new Set([...spoken].map(rootOf))
  return heard.some((w) => ANSWERING.has(w) && !said.has(rootOf(w)))
}

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right').split(' '),
)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
export function isEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (overrides(heard, spoken)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = new Set(norm(spoken).split(' '))
  if (answers(all, mine)) return false
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(w))
  }

  let hits = 0
  for (const w of content) if (mine.has(w)) hits++
  return hits / content.length >= 0.6
}
