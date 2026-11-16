/**
 * The scientific references behind MeBo's medical data model.
 *
 * S* are the sources supplied with the NASA Space Apps 2026 challenge, and are
 * the primary references. They are qualitative: they name hazards, risks and
 * research areas, but give almost no numbers. Where the synthetic scenario
 * needs a magnitude, it comes either from an E* peer-reviewed reference (cited
 * for that number only) or is marked as an illustrative assumption. E*
 * references were not among the supplied sources; they are cited from the
 * literature and should be checked against the original papers before any
 * scientific use.
 */

export const REFERENCES = {
  S1: {
    kind: 'supplied',
    title: 'NASA Human Research Program — Hazards of Human Spaceflight',
    url: 'https://www.nasa.gov/hrp/hazards/',
    used_for:
      'The five hazards: space radiation; isolation and confinement; distance from Earth; gravity fields; hostile/closed environments. Mars ~140 million miles away; Mars round trip roughly three years.',
  },
  S2: {
    kind: 'supplied',
    title: 'NASA Human Research Program — Human Health Risks',
    url: 'https://www.nasa.gov/hrp/risks/',
    used_for:
      'Risk names mapped to each indicator, e.g. "Risk of Cardiovascular Adaptations", "Risk of Inadequate Sleep and Irregular Schedules", "Risk of Radiation-Induced Cancers".',
  },
  S3: {
    kind: 'supplied',
    title: 'NASA Human Research Program — Ongoing HRP Research',
    url: 'https://www.nasa.gov/hrp/ongoing-hrp-research/',
    used_for:
      'ARCHeR (Artemis II) monitored well-being, activity and sleep patterns — the page\'s image description identifies the wrist-worn actigraphy device; Standard Measures collects physiological and psychological measurements; Zero T2 studies exercise without a treadmill.',
  },
  S4: {
    kind: 'supplied',
    title: 'CSA — Monitoring radiation to protect astronaut health (2026-02-26)',
    url: 'https://www.asc-csa.gc.ca/eng/news/articles/2026/2026-02-26-monitoring-radiation-astronaut-health.asp',
    used_for:
      'Radiation as a key challenge beyond Earth; the CANS neutron spectrometer; neutrons contribute about 30% of total radiation on the ISS. Gives no daily dose figures.',
  },
  S5: {
    kind: 'supplied',
    title: 'CSA — Why do we conduct science experiments in space?',
    url: 'https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp',
    used_for:
      'Deep-space missions mean more weightlessness, radiation and isolation; weightlessness effects resemble accelerated ageing; Canadian research on bones, heart, blood vessels and brain.',
  },
  E1: {
    kind: 'literature',
    title:
      'Zeitlin C. et al. (2013). Measurements of energetic particle radiation in transit to Mars on the Mars Science Laboratory. Science 340(6136):1080–1084.',
    url: 'https://doi.org/10.1126/science.1235989',
    used_for: 'Mean dose-equivalent rate during Mars cruise of about 1.84 mSv per day.',
  },
  E2: {
    kind: 'literature',
    title:
      'Barger L.K. et al. (2014). Prevalence of sleep deficiency and use of hypnotic drugs in astronauts before, during, and after spaceflight: an observational study. Lancet Neurology 13(9):904–912.',
    url: 'https://doi.org/10.1016/S1474-4422(14)70122-X',
    used_for: 'In-flight sleep of roughly six hours per night, shorter than before flight.',
  },
  E3: {
    kind: 'literature',
    title:
      'Norsk P. et al. (2015). Fluid shifts, vasodilatation and ambulatory blood pressure reduction during long duration spaceflight. Journal of Physiology 593(3):573–584.',
    url: 'https://doi.org/10.1113/jphysiol.2014.284869',
    used_for: 'Direction only: ambulatory blood pressure is reduced during long-duration flight.',
  },
  E4: {
    kind: 'literature',
    title:
      'Stahn A.C. et al. (2017). Increased core body temperature in astronauts during long-duration space missions. Scientific Reports 7:16180.',
    url: 'https://doi.org/10.1038/s41598-017-15560-w',
    used_for: 'Direction only: core body temperature rises gradually during long-duration flight.',
  },
}
