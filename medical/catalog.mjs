/**
 * The health indicators MeBo records, with their units and the NASA risks
 * they relate to.
 *
 * One source of truth: the database's `metrics` table is seeded from this,
 * every stored observation must carry its metric's unit (enforced by a
 * trigger), and docs/medical-data.md mirrors the risk mapping.
 *
 * `risks` quotes risk names verbatim from S2 (nasa.gov/hrp/risks). `hazards`
 * uses the five hazards from S1. `relation` says how direct the link is —
 * several indicators are general signs rather than a measure of the risk
 * itself, and the mapping says so rather than overstating it.
 */

export const METRICS = [
  {
    code: 'heart_rate',
    name: 'Heart rate',
    unit: 'bpm',
    decimals: 0,
    category: 'cardiovascular',
    description: 'Resting heart rate, spot measurement.',
    risks: ['Risk of Cardiovascular Adaptations', 'Risk of Reduced Cardiorespiratory and Musculoskeletal Fitness'],
    hazards: ['Gravity fields'],
    relation: 'Indicator of cardiovascular state; one input among many to the named risks.',
    refs: ['S1', 'S2', 'S5'],
  },
  {
    code: 'bp_systolic',
    name: 'Blood pressure, systolic',
    unit: 'mmHg',
    decimals: 0,
    category: 'cardiovascular',
    description: 'Systolic blood pressure, cuff measurement.',
    risks: ['Risk of Cardiovascular Adaptations'],
    hazards: ['Gravity fields'],
    relation: 'Indicator of cardiovascular adaptation (fluid shift).',
    refs: ['S1', 'S2', 'S5', 'E3'],
  },
  {
    code: 'bp_diastolic',
    name: 'Blood pressure, diastolic',
    unit: 'mmHg',
    decimals: 0,
    category: 'cardiovascular',
    description: 'Diastolic blood pressure, cuff measurement.',
    risks: ['Risk of Cardiovascular Adaptations'],
    hazards: ['Gravity fields'],
    relation: 'Indicator of cardiovascular adaptation (fluid shift).',
    refs: ['S1', 'S2', 'S5', 'E3'],
  },
  {
    code: 'spo2',
    name: 'Peripheral oxygen saturation',
    unit: '%',
    decimals: 0,
    category: 'respiratory',
    description: 'SpO₂, pulse oximetry spot measurement.',
    risks: ['Risk of Hypoxia'],
    hazards: ['Hostile/closed environments'],
    relation: 'Direct physiological indicator relevant to hypoxia.',
    refs: ['S1', 'S2'],
  },
  {
    code: 'respiratory_rate',
    name: 'Respiratory rate',
    unit: 'breaths/min',
    decimals: 0,
    category: 'respiratory',
    description: 'Breaths per minute at rest.',
    risks: ['Risk of Hypoxia', 'Risk of Reduced Cardiorespiratory and Musculoskeletal Fitness'],
    hazards: ['Hostile/closed environments'],
    relation: 'General vital sign; indirect link to the named risks.',
    refs: ['S1', 'S2'],
  },
  {
    code: 'body_temperature',
    name: 'Body temperature',
    unit: '°C',
    decimals: 1,
    category: 'thermoregulation',
    description: 'Core body temperature estimate.',
    risks: [],
    hazards: ['Hostile/closed environments'],
    relation:
      'General vital sign. S2 names no thermoregulation risk; S1 lists cabin temperature among closed-environment factors. Included as a standard vital sign.',
    refs: ['S1', 'E4'],
  },
  {
    code: 'sleep_duration',
    name: 'Sleep duration',
    unit: 'h',
    decimals: 1,
    category: 'sleep',
    description: 'Total sleep in the preceding sleep period, from actigraphy.',
    risks: ['Risk of Inadequate Sleep and Irregular Schedules'],
    hazards: ['Isolation and confinement', 'Hostile/closed environments'],
    relation: 'Direct measure of the named risk; actigraphy is the method S3 describes for ARCHeR.',
    refs: ['S2', 'S3', 'E2'],
  },
  {
    code: 'mood',
    name: 'Self-rated mood',
    unit: 'score (1–5)',
    decimals: 0,
    category: 'behavioural',
    description:
      'Self-rated mood, 1 (very low) to 5 (very good). A demonstration scale, not a validated psychological instrument.',
    risks: ['Risk of Behavioral Changes and Psychiatric Disorders', 'Risk of Inadequate Teamwork'],
    hazards: ['Isolation and confinement', 'Distance from Earth'],
    relation: 'Self-report of well-being, as tracked by ARCHeR and Standard Measures (S3). Not a clinical measure.',
    refs: ['S1', 'S2', 'S3'],
  },
  {
    code: 'activity',
    name: 'Exercise duration',
    unit: 'min',
    decimals: 0,
    category: 'activity',
    description: 'Minutes of countermeasure exercise in the day, from actigraphy.',
    risks: [
      'Risk of Reduced Cardiorespiratory and Musculoskeletal Fitness',
      'Risk of Spaceflight-Induced Bone Changes',
    ],
    hazards: ['Gravity fields'],
    relation: 'Records the countermeasure, not the outcome; S3 lists activity tracking (ARCHeR) and exercise research (Zero T2).',
    refs: ['S1', 'S2', 'S3'],
  },
  {
    code: 'radiation_dose',
    name: 'Recorded radiation dose',
    unit: 'mSv',
    decimals: 3,
    category: 'radiation',
    description: 'Dose equivalent recorded by a personal dosimeter over the day.',
    risks: ['Risk of Radiation-Induced Cancers'],
    hazards: ['Space radiation'],
    relation: 'Exposure measure for the named risk; cumulative dose is the quantity of interest.',
    // Exposure, not physiology: there is no personal baseline to compare a dose against.
    baseline: false,
    refs: ['S1', 'S2', 'S4', 'E1'],
  },
]

export const METRIC = Object.fromEntries(METRICS.map((m) => [m.code, m]))

/** Measurement sources. All four in this dataset are simulated devices. */
export const SOURCES = [
  {
    id: 'synthetic-wearable',
    name: 'Simulated wearable vitals monitor',
    kind: 'synthetic',
    is_simulated: 1,
    description: 'Synthetic spot readings of heart rate, SpO₂, respiratory rate and temperature.',
  },
  {
    id: 'synthetic-bp-cuff',
    name: 'Simulated blood-pressure cuff',
    kind: 'synthetic',
    is_simulated: 1,
    description: 'Synthetic morning blood-pressure readings.',
  },
  {
    id: 'synthetic-actigraphy',
    name: 'Simulated wrist actigraphy',
    kind: 'synthetic',
    is_simulated: 1,
    description: 'Synthetic sleep and exercise durations (actigraphy, as in ARCHeR — S3).',
  },
  {
    id: 'synthetic-self-report',
    name: 'Simulated self-report',
    kind: 'synthetic',
    is_simulated: 1,
    description: 'Synthetic daily self-rated mood.',
  },
  {
    id: 'synthetic-dosimeter',
    name: 'Simulated personal dosimeter',
    kind: 'synthetic',
    is_simulated: 1,
    description: 'Synthetic daily dose equivalent, in flight only.',
  },
]
