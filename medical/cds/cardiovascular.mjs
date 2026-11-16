/**
 * Cardiovascular-change assessment: heart rate, blood pressure, the person's
 * own baseline and recent trend, reported symptoms, and mission context.
 *
 * Every rule is documented in docs/clinical-decision-support.md with its
 * basis and references. Edit them there and here together; a test checks
 * that every rule id is documented.
 */

const yes = (ctx, k) => ctx.answers?.[k] === 'yes'
const hr = (ctx) => ctx.data.heart_rate.value
const sbp = (ctx) => ctx.data.bp_systolic.value
const dbp = (ctx) => ctx.data.bp_diastolic.value
const severeBp = (ctx) => sbp(ctx) > 180 || dbp(ctx) > 120
/** Symptoms that C2 lists alongside a severe reading as making it an emergency. */
const bpEmergencySymptom = (ctx) =>
  yes(ctx, 'chest_pain') || yes(ctx, 'short_of_breath') || yes(ctx, 'weak_or_lightheaded') || yes(ctx, 'radiating_pain')

const HR = 'data.heart_rate.value'
const SBP = 'data.bp_systolic.value'
const DBP = 'data.bp_diastolic.value'

const REPEAT_HR = 'Repeat the resting heart-rate reading after five minutes of quiet rest.'
const REPEAT_BP = 'Repeat the blood-pressure reading after five minutes of quiet rest.'
const NO_DELAY = 'Do not delay escalation to repeat measurements; take heart rate and blood pressure only if it causes no delay.'

export const CARDIOVASCULAR = {
  id: 'cardiovascular',
  version: 1,
  title: 'Cardiovascular change assessment',
  metrics: ['heart_rate', 'bp_systolic', 'bp_diastolic'],
  /**
   * NASA/CSA background attached to every result (knowledge base passages,
   * verbatim). Context for the reader only: no rule reads it.
   */
  background: [
    { passage: 'S2:risk-of-cardiovascular-adaptations', why: 'The NASA risk this assessment addresses.' },
    { passage: 'S1:gravity-fields-2', why: 'Why gravity changes matter to the heart and body.' },
    { passage: 'S2:risk-of-reduced-cardiorespiratory-and-musculoske', why: 'The related fitness risk, and why exercise is a countermeasure.' },
    { passage: 'S1:distance-from-earth-2', why: 'Why the escalation guidance has the crew act first on a Mars transit.' },
  ],
  questions: [
    { id: 'chest_pain' },
    { id: 'short_of_breath' },
    { id: 'fainted' },
    { id: 'weak_or_lightheaded' },
    { id: 'radiating_pain' },
    { id: 'palpitations' },
  ],
  inputs: [
    { path: HR, label: 'Current resting heart rate', required: true, action: 'Take a resting heart-rate reading.' },
    { path: SBP, label: 'Current systolic blood pressure', required: true, action: 'Take a blood-pressure reading.' },
    { path: DBP, label: 'Current diastolic blood pressure', required: true, action: 'Take a blood-pressure reading.' },
    { path: 'answers.chest_pain', label: 'Chest pain', required: true, action: 'Ask the chest-pain question.' },
    { path: 'answers.short_of_breath', label: 'Shortness of breath', required: true, action: 'Ask the shortness-of-breath question.' },
    { path: 'answers.fainted', label: 'Fainting', required: true, action: 'Ask the fainting question.' },
    { path: 'answers.weak_or_lightheaded', label: 'Weakness or light-headedness', required: true, action: 'Ask the light-headedness question.' },
    { path: 'answers.radiating_pain', label: 'Jaw, neck, back, arm or shoulder pain', required: true, action: 'Ask the jaw, neck, back, arm or shoulder pain question.' },
    { path: 'answers.palpitations', label: 'Palpitations', required: false, action: 'Ask the palpitations question.' },
  ],
  rules: [
    // --- reported symptoms ----------------------------------------------------
    {
      id: 'CV-S1', title: 'Chest pain reported', level: 'emergency', basis: 'published-adapted', refs: ['C1'],
      requires: ['answers.chest_pain'], when: (c) => yes(c, 'chest_pain'),
      statement: 'Chest pain, pressure or discomfort is reported. The CDC lists it as a major warning sign of a heart attack, to be acted on immediately.',
      next: [NO_DELAY],
    },
    {
      id: 'CV-S2', title: 'Shortness of breath at rest', level: 'emergency', basis: 'published-adapted', refs: ['C1'],
      requires: ['answers.short_of_breath'], when: (c) => yes(c, 'short_of_breath'),
      statement: 'Shortness of breath at rest is reported. The CDC lists shortness of breath as a major warning sign of a heart attack.',
      next: [NO_DELAY],
    },
    {
      id: 'CV-S3', title: 'Fainting or loss of consciousness', level: 'emergency', basis: 'prototype', refs: ['S2'],
      requires: ['answers.fainted'], when: (c) => yes(c, 'fainted'),
      statement: 'Fainting or loss of consciousness is reported. Treated as an emergency by a conservative MeBo prototype rule.',
      next: [NO_DELAY],
    },
    {
      id: 'CV-S4', title: 'Weakness or light-headedness', level: 'urgent', basis: 'published-adapted', refs: ['C1', 'S1'],
      requires: ['answers.weak_or_lightheaded'], when: (c) => yes(c, 'weak_or_lightheaded'),
      statement:
        'Feeling weak, light-headed or faint is reported, which the CDC lists among heart-attack warning signs. In microgravity there is no orthostatic load, so this is not explained by standing up.',
      next: [REPEAT_HR, REPEAT_BP],
    },
    {
      id: 'CV-S5', title: 'Jaw, neck, back, arm or shoulder pain', level: 'urgent', basis: 'published-adapted', refs: ['C1'],
      requires: ['answers.radiating_pain'], when: (c) => yes(c, 'radiating_pain'),
      statement: 'Pain or discomfort in the jaw, neck, back, arms or shoulders is reported. The CDC lists these among heart-attack warning signs.',
      next: [REPEAT_HR, REPEAT_BP],
    },
    {
      id: 'CV-S6', title: 'Palpitations reported', level: 'review', basis: 'prototype', refs: ['S2'],
      requires: ['answers.palpitations'], when: (c) => yes(c, 'palpitations'),
      statement: 'A racing, pounding or irregular heartbeat is reported.',
      next: [REPEAT_HR],
    },

    // --- blood pressure: ACC/AHA categories (via CDC) --------------------------
    {
      id: 'CV-BP-EMERGENCY', title: 'Severe blood pressure with symptoms', level: 'emergency', basis: 'published-adapted', refs: ['C2'],
      requires: [SBP, DBP], when: (c) => severeBp(c) && bpEmergencySymptom(c),
      statement: (c) => `Blood pressure ${sbp(c)}/${dbp(c)} mmHg is in the severe range (above 180 and/or above 120) with symptoms reported, which the CDC describes as an emergency.`,
      next: [NO_DELAY],
    },
    {
      id: 'CV-BP-SEVERE', title: 'Severe blood-pressure reading', level: 'urgent', basis: 'published-adapted', refs: ['C2'],
      requires: [SBP, DBP], when: (c) => severeBp(c) && !bpEmergencySymptom(c),
      statement: (c) => `Blood pressure ${sbp(c)}/${dbp(c)} mmHg is in the severe range (above 180 and/or above 120). The CDC advises contacting a health professional.`,
      next: [REPEAT_BP, 'Ask about chest pain, shortness of breath, back pain, weakness, vision change and difficulty speaking.'],
    },
    {
      id: 'CV-BP-STAGE2', title: 'Blood pressure in the stage 2 range', level: 'review', basis: 'published-adapted', refs: ['C2'],
      requires: [SBP, DBP], when: (c) => (sbp(c) >= 140 || dbp(c) >= 90) && !severeBp(c),
      statement: (c) => `Blood pressure ${sbp(c)}/${dbp(c)} mmHg is in the ACC/AHA stage 2 range (≥140 or ≥90). A single reading is not a diagnosis.`,
      next: [REPEAT_BP, 'Repeat blood-pressure readings on separate occasions; the categories are confirmed over multiple readings.'],
    },
    {
      id: 'CV-BP-STAGE1', title: 'Blood pressure in the stage 1 range', level: 'monitor', basis: 'published-adapted', refs: ['C2'],
      requires: [SBP, DBP], when: (c) => (sbp(c) >= 130 || dbp(c) >= 80) && sbp(c) < 140 && dbp(c) < 90,
      statement: (c) => `Blood pressure ${sbp(c)}/${dbp(c)} mmHg is in the ACC/AHA stage 1 range (130–139 or 80–89). A single reading is not a diagnosis.`,
      next: ['Repeat blood-pressure readings on separate occasions; the categories are confirmed over multiple readings.'],
    },

    // --- NEWS2 parameter bands ---------------------------------------------------
    {
      id: 'CV-HR-N3', title: 'Heart rate in the NEWS2 highest band', level: 'urgent', basis: 'published-adapted', refs: ['C3'],
      requires: [HR], when: (c) => hr(c) <= 40 || hr(c) >= 131,
      statement: (c) => `Resting heart rate ${hr(c)} bpm is in a NEWS2 band scoring 3 (≤40 or ≥131).`,
      next: [REPEAT_HR],
    },
    {
      id: 'CV-HR-N2', title: 'Heart rate in a NEWS2 band scoring 2', level: 'review', basis: 'published-adapted', refs: ['C3'],
      requires: [HR], when: (c) => hr(c) >= 111 && hr(c) <= 130,
      statement: (c) => `Resting heart rate ${hr(c)} bpm is in the NEWS2 band 111–130 (score 2).`,
      next: [REPEAT_HR],
    },
    {
      id: 'CV-HR-N1', title: 'Heart rate in a NEWS2 band scoring 1', level: 'monitor', basis: 'published-adapted', refs: ['C3'],
      requires: [HR], when: (c) => (hr(c) >= 41 && hr(c) <= 50) || (hr(c) >= 91 && hr(c) <= 110),
      statement: (c) =>
        `Resting heart rate ${hr(c)} bpm is in a NEWS2 band scoring 1 (41–50 or 91–110). A low resting rate can be usual for a fit person; compare with the personal baseline.`,
      next: [REPEAT_HR],
    },
    {
      id: 'CV-SBP-N3', title: 'Systolic pressure in the NEWS2 highest band', level: 'urgent', basis: 'published-adapted', refs: ['C3'],
      requires: [SBP], when: (c) => sbp(c) <= 90 || sbp(c) >= 220,
      statement: (c) => `Systolic blood pressure ${sbp(c)} mmHg is in a NEWS2 band scoring 3 (≤90 or ≥220).`,
      next: [REPEAT_BP],
    },
    {
      id: 'CV-SBP-N2', title: 'Systolic pressure in a NEWS2 band scoring 2', level: 'review', basis: 'published-adapted', refs: ['C3'],
      requires: [SBP], when: (c) => sbp(c) >= 91 && sbp(c) <= 100,
      statement: (c) => `Systolic blood pressure ${sbp(c)} mmHg is in the NEWS2 band 91–100 (score 2).`,
      next: [REPEAT_BP],
    },
    {
      id: 'CV-SBP-N1', title: 'Systolic pressure in a NEWS2 band scoring 1', level: 'monitor', basis: 'published-adapted', refs: ['C3'],
      requires: [SBP], when: (c) => sbp(c) >= 101 && sbp(c) <= 110,
      statement: (c) => `Systolic blood pressure ${sbp(c)} mmHg is in the NEWS2 band 101–110 (score 1).`,
      next: [REPEAT_BP],
    },

    // --- personal baseline and trend (statistical; prototype) -----------------------
    {
      id: 'CV-HR-BASELINE', title: 'Heart rate far from personal baseline', level: 'monitor', basis: 'prototype', refs: ['S2'],
      requires: ['data.heart_rate.z'], when: (c) => Math.abs(c.data.heart_rate.z) >= 2,
      statement: (c) =>
        `Heart rate is ${c.data.heart_rate.z} standard deviations from this person's pre-flight baseline (${c.data.heart_rate.baseline.mean} bpm). In-flight adaptation is expected to shift values; this is statistical, not clinical.`,
      next: [REPEAT_HR],
    },
    {
      id: 'CV-SBP-BASELINE', title: 'Systolic pressure far from personal baseline', level: 'monitor', basis: 'prototype', refs: ['S2', 'E3'],
      requires: ['data.bp_systolic.z'], when: (c) => Math.abs(c.data.bp_systolic.z) >= 2,
      statement: (c) =>
        `Systolic pressure is ${c.data.bp_systolic.z} standard deviations from this person's pre-flight baseline (${c.data.bp_systolic.baseline.mean} mmHg). Statistical, not clinical.`,
      next: [REPEAT_BP],
    },
    {
      id: 'CV-DBP-BASELINE', title: 'Diastolic pressure far from personal baseline', level: 'monitor', basis: 'prototype', refs: ['S2', 'E3'],
      requires: ['data.bp_diastolic.z'], when: (c) => Math.abs(c.data.bp_diastolic.z) >= 2,
      statement: (c) =>
        `Diastolic pressure is ${c.data.bp_diastolic.z} standard deviations from this person's pre-flight baseline (${c.data.bp_diastolic.baseline.mean} mmHg). Statistical, not clinical.`,
      next: [REPEAT_BP],
    },
    {
      id: 'CV-HR-TREND', title: 'Resting heart rate rising', level: 'review', basis: 'prototype', refs: ['S2'],
      requires: ['data.heart_rate.trend14', 'data.heart_rate.trend14_se'],
      when: (c) => c.data.heart_rate.trend14 >= 2 && c.data.heart_rate.trend14 - 2 * c.data.heart_rate.trend14_se > 0,
      statement: (c) => `Resting heart rate has risen by ${c.data.heart_rate.trend14} bpm per week over the last 14 days (± ${c.data.heart_rate.trend14_se} standard error), clearly beyond day-to-day noise.`,
      next: ['Review the 14-day heart-rate history with the crew medical officer.'],
    },
    {
      id: 'CV-SBP-TREND', title: 'Systolic pressure rising', level: 'review', basis: 'prototype', refs: ['S2'],
      requires: ['data.bp_systolic.trend14', 'data.bp_systolic.trend14_se'],
      when: (c) => c.data.bp_systolic.trend14 >= 3 && c.data.bp_systolic.trend14 - 2 * c.data.bp_systolic.trend14_se > 0,
      statement: (c) => `Systolic blood pressure has risen by ${c.data.bp_systolic.trend14} mmHg per week over the last 14 days (± ${c.data.bp_systolic.trend14_se} standard error), clearly beyond day-to-day noise.`,
      next: ['Review the 14-day blood-pressure history with the crew medical officer.'],
    },
  ],
}
