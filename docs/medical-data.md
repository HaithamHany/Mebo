# MeBo medical data foundation

> **All health data in MeBo is synthetic.** Four fictional astronauts on a
> fictional Mars transit, generated deterministically from the scenario
> documented below. Nothing here is, or is derived from, a real astronaut's
> measurements. MeBo makes no diagnoses, applies no clinical thresholds, and
> gives no treatment recommendations.

Step 18 of MeBo for the NASA Space Apps Challenge 2026. This document covers
the data model, how each health indicator relates to the spaceflight risks
NASA has identified, the synthetic scenario and its parameters, the analytics,
and the limits of all of it.

---

## 1. Architecture

The medical data service is a self-contained module, `medical/`, that does not
depend on any language model. The bridge's model — Gemma 4 on Hugging Face
or a local Ollama — is just one consumer of it.

```
          ┌─────────────── consumers ───────────────┐
 dashboard (HTTP)   model bridge    CLI / scripts   other tools
          │              │               │                    │
          └──── GET /medical/* ──────────┴── npm run medical ─┘
                         │
              medical/http.mjs   (read-only JSON API)
                         │
              medical/service.mjs (the one access surface)
                 │                      │
     medical/analytics.mjs      medical/db.mjs ── SQLite (node:sqlite)
     (pure functions)                   │
                              medical/scenario.mjs + catalog.mjs
                              (deterministic synthetic data)
```

| File | Role |
|---|---|
| `medical/catalog.mjs` | Indicators: code, unit, precision, NASA risk mapping. Measurement sources. |
| `medical/references.mjs` | The cited sources (S1–S5 supplied, E1–E4 literature). |
| `medical/scenario.mjs` | Scenario parameters and the deterministic generator. |
| `medical/db.mjs` | Schema, integrity triggers, seeding, dataset checksum. |
| `medical/analytics.mjs` | Baselines, trends, latest/stale, deviation. Pure functions. |
| `medical/service.mjs` | The access surface every consumer uses. |
| `medical/http.mjs` | Read-only HTTP API, mounted by the bridge and the standalone server. |
| `medical/server.mjs` | Standalone server: the service with no bridge and no model. |
| `medical/cli.mjs` | Command-line tool: JSON output for scripts and agents. |

**Storage.** SQLite through Node's built-in `node:sqlite` (Node 22.13 or
newer): no native module and no new dependency. The database is
`data/medical/mebo-medical.sqlite` (override with `MEBO_MEDICAL_DB`). It is
gitignored and created automatically on first use.

**Access.** All three routes reach the same functions:

- HTTP, through the bridge: `http://localhost:8787/medical/...`. The bridge's
  existing host and origin checks apply first.
- HTTP, with no bridge: `npm run medical:serve` serves
  `http://127.0.0.1:8788/medical/...` (loopback only).
- CLI: `npm run medical -- summary ms2`, `npm run medical -- trend ms1 heart_rate 30`, …

| Endpoint | Returns |
|---|---|
| `GET /medical/provenance` | schema/generator versions, seed, checksum, full scenario, references |
| `GET /medical/mission` | mission context |
| `GET /medical/metrics` | indicator catalogue with units and NASA risk mapping |
| `GET /medical/crew` | crew profiles |
| `GET /medical/crew/:id` | per metric: latest reading, baseline, deviation (and cumulative dose) |
| `GET /medical/crew/:id/history?metric=&days=` | timestamped observations |
| `GET /medical/crew/:id/trend?metric=&days=` | daily means, slope, coverage, missing days |
| `GET /medical/dashboard` | everything the console draws, in one call |

The API is **read-only**. Nothing a web page or a model can reach writes
health data. `service.record()` exists for future device integration and the
tests, and is not exposed over HTTP.

Every response includes `"simulated": true` and a `notice` stating that the
data is synthetic. The label travels with the data to every consumer.

**Future offline LLM.** The service has no model dependency, so a Gemma or
Ollama backend would use it by calling the HTTP API or the CLI as a tool.
That integration is not built in this step.

---

## 2. Data model

| Table | Contents |
|---|---|
| `meta` | Provenance: `schema_version`, `generator_version`, `scenario_id`, `seed`, `dataset_sha256`, `observation_count`, `scenario_json`. |
| `sources` | Measurement sources, each with `kind` (`synthetic`/`device`/`manual`) and `is_simulated`. |
| `missions` | Mission context: launch time, scenario time, phase lengths, `is_simulated`. |
| `astronauts` | Crew profiles, each with `is_synthetic`. |
| `metrics` | The indicator catalogue (from `catalog.mjs`). |
| `observations` | Every measurement: `value`, `unit`, `observed_at` (UTC ISO 8601), `mission_day`, `phase`, `source_id`, `is_simulated`, `session`. This table is the history. |

Integrity is enforced by the database itself:

- A trigger rejects any observation whose `unit` differs from its metric's
  catalogue unit.
- A trigger rejects an observation marked real (`is_simulated = 0`) that comes
  from a simulated source.
- `CHECK` constraints restrict flags and phases to valid values.

Re-seeding replaces only simulated rows, so real observations recorded later
survive.

**Mission time.** Mission day 1 is launch day; day −1 is the day before; there
is no day 0. "Now" for all analytics is the mission's `scenario_now` (the end
of the last simulated day), not the wall clock, so results never change with
the date the demo is run.

**Missing data** is the absence of a row. Nothing is interpolated or filled.
The analytics report gaps explicitly (see §5).

### Indicators and units

| Code | Indicator | Unit | Precision | Source (simulated) | Cadence |
|---|---|---|---|---|---|
| `heart_rate` | Resting heart rate | bpm | 0 | wearable | 07:00, 19:00 |
| `bp_systolic` | Systolic blood pressure | mmHg | 0 | BP cuff | 07:15 |
| `bp_diastolic` | Diastolic blood pressure | mmHg | 0 | BP cuff | 07:15 |
| `spo2` | Peripheral oxygen saturation | % | 0 | wearable | 07:00, 19:00 |
| `respiratory_rate` | Respiratory rate | breaths/min | 0 | wearable | 07:00, 19:00 |
| `body_temperature` | Core body temperature estimate | °C | 1 | wearable | 07:00, 19:00 |
| `sleep_duration` | Sleep in the preceding period | h | 1 | actigraphy | 06:30 |
| `mood` | Self-rated mood, 1 (very low) – 5 (very good) | score (1–5) | 0 | self-report | 21:00 |
| `activity` | Countermeasure exercise | min | 0 | actigraphy | 21:00 |
| `radiation_dose` | Recorded daily dose equivalent | mSv | 3 | personal dosimeter | 23:59, in flight only |

The mood scale is a demonstration scale, **not** a validated psychological
instrument.

---

## 3. Indicators and NASA's identified risks

Risk names are quoted verbatim from NASA's Human Research Program risk list
[S2]. Hazards are the five named in [S1]: space radiation, isolation and
confinement, distance from Earth, gravity fields, and hostile/closed
environments. The "Relation" column states how direct each link is. Several
indicators are general signs rather than a measure of the risk itself.

| Indicator | NASA risk(s) [S2] | Hazard(s) [S1] | Relation | Sources |
|---|---|---|---|---|
| `heart_rate` | Risk of Cardiovascular Adaptations; Risk of Reduced Cardiorespiratory and Musculoskeletal Fitness | Gravity fields | Indicator of cardiovascular state; one input among many | S1, S2, S5 |
| `bp_systolic`, `bp_diastolic` | Risk of Cardiovascular Adaptations | Gravity fields | Indicator of cardiovascular adaptation (fluid shift) | S1, S2, S5, E3 |
| `spo2` | Risk of Hypoxia | Hostile/closed environments | Direct physiological indicator relevant to hypoxia | S1, S2 |
| `respiratory_rate` | Risk of Hypoxia; Risk of Reduced Cardiorespiratory and Musculoskeletal Fitness | Hostile/closed environments | General vital sign; indirect | S1, S2 |
| `body_temperature` | none named in [S2] | Hostile/closed environments | General vital sign. [S1] lists cabin temperature among closed-environment factors | S1, E4 |
| `sleep_duration` | Risk of Inadequate Sleep and Irregular Schedules | Isolation and confinement; hostile/closed environments | Direct measure. Actigraphy is the method [S3] describes for ARCHeR | S2, S3, E2 |
| `mood` | Risk of Behavioral Changes and Psychiatric Disorders; Risk of Inadequate Teamwork | Isolation and confinement; distance from Earth | Self-report of well-being, as tracked by ARCHeR and Standard Measures [S3]. Not clinical | S1, S2, S3 |
| `activity` | Risk of Reduced Cardiorespiratory and Musculoskeletal Fitness; Risk of Spaceflight-Induced Bone Changes | Gravity fields | Records the countermeasure, not the outcome. [S3]: ARCHeR activity tracking; Zero T2 exercise research | S1, S2, S3 |
| `radiation_dose` | Risk of Radiation-Induced Cancers | Space radiation | Exposure measure. Cumulative dose is the quantity of interest | S1, S2, S4, E1 |

Supporting context from the supplied sources:

- **Radiation.** [S1] calls space radiation "one of the most hazardous aspects
  of spaceflight". [S4] (CSA) describes radiation as one of the key
  challenges beyond Earth, and the CANS neutron spectrometer. It notes that
  neutrons contribute about 30% of total radiation on the ISS.
- **Deep space.** [S5] (CSA) notes that Moon and Mars missions mean more
  weightlessness, more radiation and longer isolation. It also says
  weightlessness effects resemble accelerated ageing.
- **Distance.** [S1] puts Mars about 140 million miles away and a round trip
  at roughly three years. "Planning and self-sufficiency will be key" — the
  motivation for an onboard companion with local data.

NASA risks with **no** indicator in this step: altered immune responses,
sensorimotor/vestibular function, decompression sickness, host–microorganism
interactions, food and nutrition, spacewalk injury, SANS, inadequate systems
operations support, and injury from dynamic loads.

---

## 4. The synthetic scenario

**Mission** `mars-transit-demo`: fictional launch on 2033-04-20 (mission day
1). There are 28 days of pre-flight baseline (days −28 to −1), then the first
120 days of an outbound Mars transit. The planned transit of 210 days is an
illustrative assumption from [S1]'s distances. Scenario time is the end of day
120.

**Crew** (fictional; ids match the console):

| Id | Callsign | Role | Pattern |
|---|---|---|---|
| `cdr` | REYES | CDR | Nominal adaptation |
| `plt` | OKAFOR | PLT | ~6% of evening wearable checks skipped |
| `ms1` | CHEN | MS1 | Wearable offline days 61–67 and 118–120 (latest reading stale) |
| `ms2` | NOVAK | MS2 | Illustrative storyline: shorter sleep, lower mood, higher HR from day 45 |

**Model.** For each person, metric, day and session:

```
value = base(person) + change(day) + time-of-day offset + storyline(day) + noise
```

The change shapes are:

- `adapt`: A·(1 − e^(−day/τ))
- `level`: move to an absolute in-flight level with time constant τ, keeping a
  fraction of the person's pre-flight difference from the crew mean
- `drift`: A·day/N

Noise is Gaussian with the stated standard deviation. Values are clamped to
physical ranges (SpO₂ ≤ 100, mood 1–5, durations ≥ 0) and rounded to the
metric's precision. Before flight, `change` is zero.

**Basis key.** `literature`: the magnitude is from the cited reference.
`literature-direction`: the direction is from the reference; the magnitude is
an illustrative assumption. `illustrative`: an assumption chosen to be
plausible and visible in a demonstration, not derived from flight data.

| Metric | In-flight change | Noise SD | Other | Basis | Refs |
|---|---|---|---|---|---|
| `heart_rate` | adapt, −3 bpm, τ 10 d | 3 bpm | evening +4 bpm | illustrative | S2 |
| `bp_systolic` | adapt, −6 mmHg, τ 7 d | 5 mmHg | morning only | literature-direction | S2, E3 |
| `bp_diastolic` | adapt, −4 mmHg, τ 7 d | 4 mmHg | morning only | literature-direction | S2, E3 |
| `spo2` | none | 0.6 % | ≤ 100 | illustrative (nominal cabin atmosphere; no hypoxia event simulated) | S2 |
| `respiratory_rate` | none | 1.1 /min | — | illustrative | — |
| `body_temperature` | adapt, +0.3 °C, τ 45 d | 0.12 °C | evening +0.3 °C | literature-direction (+0.3 °C is conservative) | E4 |
| `sleep_duration` | level 6.0 h (± half of pre-flight offset), τ 3 d | 0.45 h | — | literature | S2, S3, E2 |
| `mood` | drift −0.3 over 120 d | 0.55 | 1–5, integer | illustrative | S1, S2 |
| `activity` | level 100 min (± half of pre-flight offset), τ 2 d | 12 min | — | illustrative | S2, S3 |
| `radiation_dose` | 1.84 mSv/day × personal factor (0.96–1.03) | 0.08 mSv | in flight only | literature (rate); factors illustrative | S1, S4, E1 |

Events and storylines, all **illustrative**:

- **Elevated-dose day** (mission day 74, all crew): 4 × the usual daily dose.
  It stands in for a solar particle event; the multiplier is not derived from
  any measured event. [S1, S4]
- **Novak storyline** (from day 45, ramping over 30 days): sleep −0.9 h, mood
  −1.0, heart rate +5 bpm. It exists to exercise the baseline-deviation
  analytics, with reference to Risk of Inadequate Sleep and Irregular
  Schedules and Risk of Behavioral Changes and Psychiatric Disorders. [S2]

Missing-data patterns are listed in the crew table above. In addition, about
4% of morning blood-pressure readings are not taken, for all crew.

**Determinism.**

- Generator version 1, seed `0x4d65426f` (1298481775).
- PRNG: mulberry32, one independent stream per astronaut and metric. Gap
  decisions come from their own stream, and every reading draws its noise
  whether or not it is kept, so gaps never shift other values.
- The generator reads no clock and calls no `Math.random`.
- Expected result: **8,022 observations**, dataset SHA-256
  `d33193f011f896a22bb5a511b347879a135b36b0559ec3d0d5813af9cd988f2b`.
- Verify with `npm run medical -- provenance`.

The full parameter set is stored in the database (`meta.scenario_json`) and
returned by `GET /medical/provenance`.

---

## 5. Analytics (`medical/analytics.mjs`)

All analytics are descriptive statistics, computed per person.

- **Baseline:** mean, SD (sample), median and n of the person's pre-flight
  observations. If there are fewer than 5, the first 14 in-flight days are
  used, and `method` says so. Radiation has no baseline: it is exposure, not
  physiology, and is summarised as a cumulative dose instead.
- **Latest:** the most recent observation at or before scenario time, with its
  age. A reading older than 48 h is returned but marked `stale`. It is "the
  last reading", not "the current reading".
- **Deviation:** `delta` = latest − baseline mean, and `z` = delta / baseline
  SD. There is no deviation without a current reading. The console draws a
  value in amber at |z| ≥ 2. That is **a statistical cue, not a clinical
  threshold**: in-flight adaptation is expected to move values away from the
  ground baseline, and amber means only "unusual for this person".
- **Trend:** over a window of mission days, the daily means, ordinary
  least-squares slope (per week), observation count, coverage (days with data
  ÷ days in the window), and the list of `missing_days`.

Nothing in the analytics labels a value normal or abnormal, names a
condition, or suggests an action.

---

## 6. The console

The crew dashboard and the cardiovascular monitor read
`GET /medical/dashboard` through the bridge (`src/ui/medical/telemetry.ts`).
The page design is unchanged; what changed:

- Values come from the latest recorded observation.
- A dash (—) means no current reading. The ECG trace runs flat and the
  anatomy heart rests when there is no current heart rate.
- Amber means deviation from the person's own baseline, as defined above. It
  replaces the earlier population "display bands", which looked like clinical
  ranges.
- The crew trend sparkline is the last 30 days of daily mean heart rate.
- The cardio grid's former HRV cell, which had no data source, now shows heart
  rate relative to the person's baseline (Δ BASE).
- Mission Status shows the mission, crew count, and the crew's latest recorded
  daily dose from the database.
- The other cabin-environment readouts (pressure, ppO₂, ppCO₂, temperature,
  humidity) remain a client-side simulation. Cabin environment is outside this
  step's data scope. The card is labelled SIMULATED either way.

If the bridge is not running, the cards say the medical data service is
offline. They never fall back to invented values.

---

## 7. References

Supplied with the challenge (primary references):

- **S1** NASA HRP, Hazards of Human Spaceflight — https://www.nasa.gov/hrp/hazards/
- **S2** NASA HRP, Human Health Risks — https://www.nasa.gov/hrp/risks/
- **S3** NASA HRP, Ongoing HRP Research — https://www.nasa.gov/hrp/ongoing-hrp-research/
- **S4** CSA, Monitoring radiation to protect astronaut health (2026-02-26) —
  https://www.asc-csa.gc.ca/eng/news/articles/2026/2026-02-26-monitoring-radiation-astronaut-health.asp
- **S5** CSA, Why do we conduct science experiments in space? —
  https://www.asc-csa.gc.ca/eng/iss/science/why-do-we-conduct-science-experiments-in-space.asp

Peer-reviewed literature, cited only where the supplied sources give no
magnitude. These were **not** among the supplied sources. Check them against
the original papers before any scientific use.

- **E1** Zeitlin C. et al. (2013). Measurements of energetic particle radiation in transit to Mars on the Mars Science Laboratory. *Science* 340(6136):1080–1084. https://doi.org/10.1126/science.1235989
- **E2** Barger L.K. et al. (2014). Prevalence of sleep deficiency and use of hypnotic drugs in astronauts before, during, and after spaceflight. *Lancet Neurology* 13(9):904–912. https://doi.org/10.1016/S1474-4422(14)70122-X
- **E3** Norsk P. et al. (2015). Fluid shifts, vasodilatation and ambulatory blood pressure reduction during long duration spaceflight. *Journal of Physiology* 593(3):573–584. https://doi.org/10.1113/jphysiol.2014.284869
- **E4** Stahn A.C. et al. (2017). Increased core body temperature in astronauts during long-duration space missions. *Scientific Reports* 7:16180. https://doi.org/10.1038/s41598-017-15560-w

---

## 8. Limitations

- **Synthetic only.** The data demonstrates the pipeline. It carries no
  information about real astronauts or real Mars-transit physiology.
- **Few magnitudes are sourced.** The supplied NASA/CSA sources are
  qualitative. Only the Mars-cruise dose rate (E1) and in-flight sleep
  duration (E2) are literature magnitudes. Every other magnitude is an
  illustrative assumption, labelled as such above.
- **Simple physiology.** Smooth adaptation curves and independent Gaussian
  noise. The model has no between-metric coupling (for example, sleep loss
  does not affect heart rate except in the Novak storyline), no weekly
  schedule effects, and no measurement artefacts.
- **Not clinically valid.** The mood scale is not a validated instrument.
  Baselines come from 28 pre-flight days. The z-score assumes roughly normal
  noise. None of it is clinically validated.
- **Coverage.** Cabin environment is not yet in the database, and several
  NASA risks have no indicator (§3).
- **Runtime.** `node:sqlite` needs Node 22.13+. On older Node the rest of
  MeBo works and `/medical` answers 503.
- **No real-device ingestion yet.** The schema supports real sources
  (`kind = 'device'`, `is_simulated = 0`), but none are integrated.
