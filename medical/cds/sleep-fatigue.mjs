/**
 * Sleep and fatigue assessment: sleep duration and its recent change against
 * the person's baseline, self-reported fatigue, mood, and schedule changes.
 *
 * Every rule is documented in docs/clinical-decision-support.md with its
 * basis and references; a test checks that every rule id is documented.
 */

const yes = (ctx, k) => ctx.answers?.[k] === 'yes'
const sleep7 = (ctx) => ctx.data.sleep_duration.mean7
const mood = (ctx) => ctx.data.mood

/**
 * Low mood on the demonstration scale: a 7-day mean of 2.5 or less, or two SD
 * below the person's own baseline. Prototype assumption. It also decides
 * whether the self-harm question is asked.
 */
export const moodLow = (ctx) =>
  (mood(ctx)?.mean7 !== null && mood(ctx)?.mean7 !== undefined && mood(ctx).mean7 <= 2.5) ||
  (mood(ctx)?.z7 !== null && mood(ctx)?.z7 !== undefined && mood(ctx).z7 <= -2)

const DEFER =
  'Consider deferring safety-critical tasks until the crew medical officer has reviewed.'
const SLEEP_REVIEW = 'Review sleep opportunity and the work schedule with the crew medical officer.'

export const SLEEP_FATIGUE = {
  id: 'sleep_fatigue',
  version: 1,
  title: 'Sleep and fatigue assessment',
  metrics: ['sleep_duration', 'mood'],
  /**
   * NASA/CSA background attached to every result (knowledge base passages,
   * verbatim). Context for the reader only: no rule reads it.
   */
  background: [
    { passage: 'S2:risk-of-inadequate-sleep-and-irregular-schedules', why: 'The NASA risk this assessment addresses.' },
    { passage: 'S3:archer', why: 'How NASA monitors sleep and activity in deep space (Artemis II).' },
    { passage: 'S2:risk-of-behavioral-changes-and-psychiatric-disor', why: 'The NASA risk behind the mood questions.' },
    { passage: 'S1:isolation-and-confinement-2', why: 'How isolation and confinement affect a crew.' },
    { passage: 'S1:distance-from-earth-2', why: 'Why the escalation guidance has the crew act first on a Mars transit.' },
  ],
  questions: [
    { id: 'fatigue' },
    { id: 'dozed_on_task' },
    { id: 'schedule_shift' },
    // Asked only when the data shows low mood, and then it must be answered.
    { id: 'self_harm', ask_if: moodLow },
  ],
  inputs: [
    { path: 'data.sleep_duration.value', label: "Last night's sleep", required: true, action: "Record last night's sleep (actigraphy)." },
    {
      path: 'data.sleep_duration.mean7', label: '7-night sleep average', required: true,
      action: 'At least four of the last seven nights of sleep data are needed.',
    },
    { path: 'data.mood.mean7', label: '7-day mood average', required: false, action: 'Record the daily mood self-report.' },
    { path: 'answers.fatigue', label: 'Self-rated fatigue', required: true, action: 'Ask the fatigue question.' },
    { path: 'answers.dozed_on_task', label: 'Falling asleep during a task', required: true, action: 'Ask about falling asleep during tasks.' },
    { path: 'answers.schedule_shift', label: 'Schedule change', required: false, action: 'Ask about schedule changes.' },
    {
      path: 'answers.self_harm', label: 'Thoughts of self-harm', required: true, when: moodLow,
      action: 'Ask, gently and privately, the self-harm question.',
    },
  ],
  rules: [
    // --- sleep ------------------------------------------------------------------------
    {
      id: 'SL-CONSENSUS', title: 'Sleep below the adult consensus', level: 'monitor', basis: 'published-adapted', refs: ['C4', 'S2', 'E2'],
      requires: ['data.sleep_duration.mean7'], when: (c) => sleep7(c) < 7,
      statement: (c) =>
        `The 7-night average is ${sleep7(c)} h, below the 7 or more hours the AASM/SRS consensus recommends for adults. Short sleep is common in spaceflight and is a NASA-identified risk.`,
      next: [SLEEP_REVIEW],
    },
    {
      id: 'SL-SHORT', title: 'Sleep under six hours', level: 'review', basis: 'prototype', refs: ['S2', 'E2'],
      requires: ['data.sleep_duration.mean7'], when: (c) => sleep7(c) < 6,
      statement: (c) => `The 7-night average is ${sleep7(c)} h, under six hours a night.`,
      next: [SLEEP_REVIEW],
    },
    {
      id: 'SL-BASELINE', title: 'Sleep well below personal baseline', level: 'review', basis: 'prototype', refs: ['S2'],
      requires: ['data.sleep_duration.z7'], when: (c) => c.data.sleep_duration.z7 <= -2,
      statement: (c) =>
        `The 7-night average is ${c.data.sleep_duration.z7} standard deviations below this person's pre-flight baseline (${c.data.sleep_duration.baseline.mean} h). Statistical, not clinical.`,
      next: [SLEEP_REVIEW],
    },
    {
      id: 'SL-TREND', title: 'Sleep falling', level: 'monitor', basis: 'prototype', refs: ['S2'],
      requires: ['data.sleep_duration.trend14', 'data.sleep_duration.trend14_se'],
      when: (c) => c.data.sleep_duration.trend14 <= -0.25 && c.data.sleep_duration.trend14 + 2 * c.data.sleep_duration.trend14_se < 0,
      statement: (c) => `Sleep has fallen by ${Math.abs(c.data.sleep_duration.trend14)} h per week over the last 14 days.`,
      next: [SLEEP_REVIEW],
    },

    // --- fatigue and alertness -----------------------------------------------------
    {
      id: 'FT-HIGH', title: 'High self-rated fatigue', level: 'review', basis: 'prototype', refs: ['S2'],
      requires: ['answers.fatigue'], when: (c) => c.answers.fatigue === 4,
      statement: 'Self-rated fatigue is 4 of 5 (very tired) on the MeBo demonstration scale.',
      next: ['Repeat the fatigue rating after the next sleep period.'],
    },
    {
      id: 'FT-EXHAUSTED', title: 'Exhaustion reported', level: 'urgent', basis: 'prototype', refs: ['S2'],
      requires: ['answers.fatigue'], when: (c) => c.answers.fatigue === 5,
      statement: 'Self-rated fatigue is 5 of 5 (exhausted) on the MeBo demonstration scale.',
      next: [DEFER],
    },
    {
      id: 'FT-DOZE', title: 'Fell asleep during a task', level: 'urgent', basis: 'prototype', refs: ['S2'],
      requires: ['answers.dozed_on_task'], when: (c) => yes(c, 'dozed_on_task'),
      statement: 'Falling asleep, or nearly falling asleep, during a task is reported. This is an operational safety concern.',
      next: [DEFER],
    },
    {
      id: 'SC-SHIFT', title: 'Recent schedule change', level: 'monitor', basis: 'prototype', refs: ['S2'],
      requires: ['answers.schedule_shift'], when: (c) => yes(c, 'schedule_shift'),
      statement: 'The sleep or work schedule shifted in the last week. NASA identifies inadequate sleep and irregular schedules as a spaceflight risk.',
      next: ['Note the schedule change in the next sleep review.'],
    },

    // --- mood ---------------------------------------------------------------------------
    {
      id: 'MD-LOW', title: 'Low mood', level: 'review', basis: 'prototype', refs: ['S2', 'S3'],
      requires: ['data.mood.mean7'], when: moodLow,
      statement: (c) =>
        `Self-rated mood has averaged ${mood(c).mean7} of 5 over 7 days${mood(c).z7 !== null ? ` (${mood(c).z7} SD from this person's baseline)` : ''} on the MeBo demonstration scale.`,
      next: ['Arrange a private conversation with the crew medical officer and ground behavioural-health support.'],
    },
    {
      id: 'MD-SELFHARM', title: 'Thoughts of self-harm', level: 'emergency', basis: 'prototype', refs: ['S2'],
      requires: ['answers.self_harm'], when: (c) => yes(c, 'self_harm'),
      statement: 'Thoughts of self-harm are reported. A conservative MeBo prototype rule treats any such report as an emergency.',
      next: ['Make sure the crew member is not alone, and involve the crew medical officer now.'],
    },
  ],
}
