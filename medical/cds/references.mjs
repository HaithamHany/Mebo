/**
 * Clinical references behind the decision-support rules.
 *
 * The five NASA/CSA sources (S1–S5, ../references.mjs) say which risks matter
 * in spaceflight, but give no clinical thresholds. Where a rule needs a
 * number, it comes from one of the published clinical sources below, and
 * `verified` records how its exact values were checked. Anything else is a
 * MeBo prototype assumption, labelled on the rule itself.
 *
 * None of these sources was written for astronauts. Applying them in flight
 * is itself a prototype assumption, and the documentation says so.
 */

export const CLINICAL_REFERENCES = {
  C1: {
    kind: 'clinical',
    title: 'CDC — Heart Attack Symptoms, Risk, and Recovery',
    url: 'https://www.cdc.gov/heart-disease/about/heart-attack.html',
    used_for:
      'Major warning signs: chest pain or discomfort; feeling weak, light-headed, or faint; pain or discomfort in the jaw, neck, or back; pain or discomfort in one or both arms or shoulders; shortness of breath. Advice: call emergency services immediately.',
    verified: 'Wording read from the page during Step 20.',
  },
  C2: {
    kind: 'clinical',
    title: 'CDC — About High Blood Pressure (ACC/AHA blood-pressure categories)',
    url: 'https://www.cdc.gov/high-blood-pressure/about/index.html',
    used_for:
      'Categories: normal <120 and <80; elevated 120–129 and <80; stage 1 130–139 or 80–89; stage 2 ≥140 or ≥90; severe >180 and/or >120 (call a health professional; with symptoms such as chest pain or shortness of breath, an emergency). Diagnosis needs multiple readings.',
    verified: 'Numbers read from the page during Step 20.',
  },
  C3: {
    kind: 'clinical',
    title: 'Royal College of Physicians (2017). National Early Warning Score (NEWS) 2.',
    url: 'https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/',
    used_for:
      'Parameter score bands. Pulse: ≤40 → 3; 41–50 → 1; 51–90 → 0; 91–110 → 1; 111–130 → 2; ≥131 → 3. Systolic BP: ≤90 → 3; 91–100 → 2; 101–110 → 1; 111–219 → 0; ≥220 → 3. Only these bands are used; MeBo does not compute an aggregate NEWS2 score.',
    verified:
      'Bands read from the MDCalc NEWS2 calculator (https://www.mdcalc.com/calc/10083/national-early-warning-score-news-2). The RCP page states there is no copyright restriction on NEWS2. The RCP response thresholds could not be accessed, so they are not used.',
  },
  C4: {
    kind: 'clinical',
    title:
      'Watson N.F. et al. (2015). Recommended Amount of Sleep for a Healthy Adult: A Joint Consensus Statement of the American Academy of Sleep Medicine and Sleep Research Society. Sleep 38(6):843–844.',
    url: 'https://doi.org/10.5665/sleep.4716',
    used_for:
      '"Adults should sleep 7 or more hours per night on a regular basis to promote optimal health." Sleeping less than 7 hours regularly is associated with adverse health outcomes.',
    verified: 'Wording read from PMC4434546 during Step 20.',
  },
}
