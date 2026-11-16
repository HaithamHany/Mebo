# MeBo clinical decision support

> **Prototype decision support, on synthetic data.** MeBo's assessments apply
> fixed, documented rules to the fictional crew's synthetic data
> ([medical-data.md](medical-data.md)). They are not diagnoses, they prescribe
> nothing, and they do not replace the crew medical officer (CMO) or the
> flight surgeon. None of the rules has been clinically validated, and none
> was written for astronauts.

Step 20 of MeBo for the NASA Space Apps Challenge 2026. This document covers
the engine choice, the two assessment workflows, every rule with its basis
and references, and the limitations.

---

## 1. What an assessment returns

`assess(crew, workflow, answers)` returns one structured, reproducible
record:

| Field | Contents |
|---|---|
| `status` | `complete`, or `incomplete` when required data or answers are missing. |
| `level` | The highest level of any rule that fired: `none` < `monitor` < `review` < `urgent` < `emergency`. |
| `summary` | A fixed-template one-line summary. |
| `observations` | Every value the rules could read, each with its database `observation_id`, source, baseline, z-score, 7-day mean and 14-day trend. |
| `answers` | The validated self-assessment answers. |
| `evidence` | Each rule that fired: its id, level, basis, the exact inputs it read, the observation ids, the statement, and its references (with URLs). |
| `concerns` | The fired rules' statements, most severe first. |
| `missing` | Each missing input, why it is missing (no reading, stale reading and its age, not answered), and what to do. |
| `next_assessments` | Predefined next steps, de-duplicated, each with the rules that asked for it. |
| `escalation` | The fixed guidance for the level, plus the incomplete-assessment warning when it applies. |
| `rules_evaluated` | Every rule with its result: `true`, `false`, or `null` (not evaluable: its inputs are missing). |
| `trace` | Engine and ruleset versions, the dataset SHA-256, a SHA-256 of all inputs, and an `assessment_id`. |
| `background` | Step 22. Fixed NASA/CSA passages for the workflow, verbatim and cited, each with the reason it is there. **Context only.** It is attached after the rules have decided and outside the traced body, so it cannot change any field above or the `assessment_id`. A test injects hostile text into it to prove this ([nasa-resource-traceability.md](nasa-resource-traceability.md) §4). |

**Missing data never reads as reassurance.**

- A rule whose inputs are missing evaluates to `null`, not `false`.
- A stale reading (older than 48 h) is not a current value.
- Any missing required input makes the status `incomplete`, and the escalation
  then carries the warning: "The absence of a concern in an incomplete
  assessment is not reassurance."

**Reproducible and traceable.** The engine reads no clock, makes no network
call and draws no random number. The same data and answers always give the
same record, down to the `assessment_id`. Every fired rule names the
observations it read by database id, and the trace carries the dataset
checksum.

### Escalation levels

The guidance is fixed text. An assistant relays it; it does not compose it.

| Level | Guidance |
|---|---|
| `none` | No escalation. Continue routine monitoring. |
| `monitor` | No escalation needed now. Continue routine monitoring and repeat at the next scheduled check. |
| `review` | Report to the CMO at the next opportunity, and include it in the next routine medical conference with the ground flight surgeon. |
| `urgent` | Inform the CMO now. The CMO should consult the ground flight surgeon at the earliest communication opportunity. |
| `emergency` | Alert the CMO immediately and follow onboard emergency procedures. Notify the ground flight surgeon at once; with communication delays on a Mars transit, the crew acts first. |

The terrestrial sources say "call 911" (C1, C2) or "call your health care
professional" (C2). Mapping those to the CMO and the ground flight surgeon is
a **prototype assumption**. It is informed by S1: on a Mars mission,
"planning and self-sufficiency will be key".

---

## 2. Engine choice: a small transparent rules engine

The step asked for a survey of existing open-source clinical decision-support
engines, adopting one only if it is practical, appropriately licensed and
genuinely useful offline. The findings, from each project's own pages:

| Candidate | What it is | Licence | Verdict for MeBo |
|---|---|---|---|
| **CQL** via `cql-execution` (cqframework) | JS library that executes CQL compiled to ELM JSON | Apache-2.0 | Runs offline in Node. But CQL must be compiled to ELM by the separate Java `cql-to-elm` translator (Java 17). The engine also "does not provide robust support for any particular data model", so patient data needs a FHIR mapping (e.g. `cql-exec-fhir`). There are no existing CQL libraries for spaceflight vitals. Not adopted, because a JVM build step plus a FHIR layer for about 30 rules adds risk without adding knowledge. |
| **OpenCDS** | Java-based CDS engine; rules in Java/Drools (CQL "future support") | Apache 2 | Needs a JVM service. Its pages name no shipped clinical content. Not adopted: a server stack for an offline crew device, with no relevant content. |
| **CDS Hooks** | A specification for invoking decision support from an EHR workflow | CC BY 4.0 | A protocol, not an engine; it assumes an EHR client. Not applicable. |
| **SNOMED CT** (terminology used with FHIR CDS) | Clinical terminology | Free in member countries; affiliate licence, possibly with fees, elsewhere | Not needed: MeBo's ten indicators and ten questions need no terminology server. Licensing varies by country. Not adopted. |

**Decision.** A small JavaScript rules engine (`medical/cds/engine.mjs`,
about 200 lines). Every rule is a data record: id, level, basis, references,
required inputs, a one-line condition, statement and next steps. It is pure,
offline and fully tested.

**What is reused** is published clinical *knowledge*, encoded verbatim and
cited rule by rule: NEWS2 parameter bands, ACC/AHA blood-pressure categories,
CDC heart-attack warning signs, and the AASM/SRS adult sleep consensus. No
external clinical *software* is reused.

The rule format maps one-to-one onto CQL `define` statements, so the rules
could be ported to CQL later if interoperability with FHIR systems is needed.

---

## 3. Evidence: what is published and what is assumed

The five supplied NASA/CSA sources (S1–S5, [medical-data.md](medical-data.md)
§7) establish **which risks matter**: Risk of Cardiovascular Adaptations,
Risk of Inadequate Sleep and Irregular Schedules, Risk of Behavioral Changes
and Psychiatric Disorders, distance from Earth and self-sufficiency. They
contain **no clinical thresholds**. Every number in a rule therefore comes
from one of the clinical sources below, or is a labelled prototype
assumption.

| Id | Source | Used for | How it was verified |
|---|---|---|---|
| C1 | CDC, Heart Attack Symptoms, Risk, and Recovery — https://www.cdc.gov/heart-disease/about/heart-attack.html | Warning signs: chest pain or discomfort; feeling weak, light-headed, or faint; jaw, neck or back pain; arm or shoulder pain; shortness of breath. Advice: call emergency services immediately. | Read from the page in Step 20 |
| C2 | CDC, About High Blood Pressure (ACC/AHA categories) — https://www.cdc.gov/high-blood-pressure/about/index.html | Normal <120/<80; elevated 120–129/<80; stage 1 130–139 or 80–89; stage 2 ≥140 or ≥90; severe >180 and/or >120 (with symptoms, an emergency). Categories are confirmed over multiple readings. | Read from the page in Step 20 |
| C3 | Royal College of Physicians (2017), NEWS2 — https://www.rcp.ac.uk/improving-care/resources/national-early-warning-score-news-2/ | Pulse bands ≤40 / 41–50 / 51–90 / 91–110 / 111–130 / ≥131 scoring 3/1/0/1/2/3. Systolic bands ≤90 / 91–100 / 101–110 / 111–219 / ≥220 scoring 3/2/1/0/3. | Bands read from the MDCalc NEWS2 calculator. The RCP states there is no copyright restriction on NEWS2. **The RCP aggregate response thresholds could not be accessed and are not used**; MeBo computes no aggregate NEWS2 score. |
| C4 | Watson N.F. et al. (2015), *Sleep* 38(6):843–844 — https://doi.org/10.5665/sleep.4716 | "Adults should sleep 7 or more hours per night on a regular basis to promote optimal health." | Read from PMC4434546 in Step 20 |

The literature references E2 (in-flight sleep of about 6 h) and E3
(in-flight blood-pressure reduction) are reused from Step 18 for context.

**Basis key.** Every rule carries one of these:

- `published`: threshold and response both from the source. *No rule
  qualifies.* Every published threshold here needed a spaceflight escalation
  mapping that no source provides.
- `published-adapted`: the threshold or warning sign is from the source; the
  escalation level is a MeBo prototype mapping.
- `prototype`: a MeBo prototype assumption. Where a NASA risk is cited, it
  explains *why the rule exists*, not where the number came from.

**Not used, because it could not be verified.** The Samn–Perelli seven-point
fatigue scale was the intended fatigue question. Its exact anchor wording
could not be confirmed from an accessible copy of the original report, so a
plainly labelled MeBo demonstration scale (1–5) is used instead.

---

## 4. Workflow 1: cardiovascular change (`cardiovascular`, v1)

**Data:** current resting heart rate and blood pressure (no older than 48 h),
personal pre-flight baseline (mean, SD, z), and 14-day trend (slope and its
standard error). **Mission context:** mission day and environment
(microgravity transit; there is no orthostatic load, per S1's "gravity
fields").

**Self-assessment questions,** asked in this order with fixed wording:

1. `chest_pain`: "Do you have any chest pain, pressure or discomfort right now?"
2. `short_of_breath`: "Are you short of breath right now, while resting?"
3. `fainted`: "Have you fainted or lost consciousness since your last check?"
4. `weak_or_lightheaded`: "Do you feel weak, light-headed or faint?"
5. `radiating_pain`: "Do you have pain or discomfort in your jaw, neck, back, arms or shoulders?"
6. `palpitations`: "Have you noticed a racing, pounding or irregular heartbeat?"

**Required inputs:** heart rate, systolic and diastolic pressure, and
questions 1–5. Question 6 is optional.

| Rule | Title | Level | Basis | Refs | Condition |
|---|---|---|---|---|---|
| `CV-S1` | Chest pain reported | emergency | published-adapted | C1 | chest_pain = yes |
| `CV-S2` | Shortness of breath at rest | emergency | published-adapted | C1 | short_of_breath = yes |
| `CV-S3` | Fainting or loss of consciousness | emergency | prototype | S2 | fainted = yes (conservative) |
| `CV-S4` | Weakness or light-headedness | urgent | published-adapted | C1, S1 | weak_or_lightheaded = yes |
| `CV-S5` | Jaw, neck, back, arm or shoulder pain | urgent | published-adapted | C1 | radiating_pain = yes |
| `CV-S6` | Palpitations reported | review | prototype | S2 | palpitations = yes |
| `CV-BP-EMERGENCY` | Severe blood pressure with symptoms | emergency | published-adapted | C2 | (SBP > 180 or DBP > 120) and any of chest_pain, short_of_breath, weak_or_lightheaded, radiating_pain = yes |
| `CV-BP-SEVERE` | Severe blood-pressure reading | urgent | published-adapted | C2 | (SBP > 180 or DBP > 120), none of those symptoms |
| `CV-BP-STAGE2` | Blood pressure in the stage 2 range | review | published-adapted | C2 | (SBP ≥ 140 or DBP ≥ 90), not severe |
| `CV-BP-STAGE1` | Blood pressure in the stage 1 range | monitor | published-adapted | C2 | (SBP ≥ 130 or DBP ≥ 80), SBP < 140 and DBP < 90 |
| `CV-HR-N3` | Heart rate in the NEWS2 highest band | urgent | published-adapted | C3 | HR ≤ 40 or ≥ 131 |
| `CV-HR-N2` | Heart rate in a NEWS2 band scoring 2 | review | published-adapted | C3 | HR 111–130 |
| `CV-HR-N1` | Heart rate in a NEWS2 band scoring 1 | monitor | published-adapted | C3 | HR 41–50 or 91–110 |
| `CV-SBP-N3` | Systolic pressure in the NEWS2 highest band | urgent | published-adapted | C3 | SBP ≤ 90 or ≥ 220 |
| `CV-SBP-N2` | Systolic pressure in a NEWS2 band scoring 2 | review | published-adapted | C3 | SBP 91–100 |
| `CV-SBP-N1` | Systolic pressure in a NEWS2 band scoring 1 | monitor | published-adapted | C3 | SBP 101–110 |
| `CV-HR-BASELINE` | Heart rate far from personal baseline | monitor | prototype | S2 | \|z\| ≥ 2 against the pre-flight baseline |
| `CV-SBP-BASELINE` | Systolic pressure far from personal baseline | monitor | prototype | S2, E3 | \|z\| ≥ 2 |
| `CV-DBP-BASELINE` | Diastolic pressure far from personal baseline | monitor | prototype | S2, E3 | \|z\| ≥ 2 |
| `CV-HR-TREND` | Resting heart rate rising | review | prototype | S2 | 14-day slope ≥ +2 bpm/week and slope − 2·SE > 0 |
| `CV-SBP-TREND` | Systolic pressure rising | review | prototype | S2 | 14-day slope ≥ +3 mmHg/week and slope − 2·SE > 0 |

Notes:

- **Single readings.** The blood-pressure statements always say a single
  reading is not a diagnosis, and the next steps ask for repeated readings
  (C2).
- **Mutually exclusive bands.** The NEWS2 bands do not overlap, and the
  blood-pressure categories are made exclusive, so a single reading fires
  one band rule per parameter. SBP ≥ 220 legitimately fires both
  `CV-SBP-N3` and a severe-BP rule.
- **Trend significance.** The trend rules require the slope to clear twice
  its standard error. Without that, a 14-day slope from one noisy reading a
  day mostly measures noise: in the synthetic data, a single cuff reading
  with SD 5 mmHg gives a slope SE of about 2 mmHg/week.
- **In-flight shifts are expected.** NASA's cardiovascular-adaptations risk
  (S2) means values do move in flight, which is why baseline deviation only
  reaches `monitor`.
- **Light-headedness in microgravity.** `CV-S4`'s statement notes that
  there is no orthostatic load in transit, so light-headedness is not
  explained by standing up.

---

## 5. Workflow 2: sleep and fatigue (`sleep_fatigue`, v1)

**Data:** last night's sleep, the 7-night mean (at least 4 of the last 7
nights needed), its z against the pre-flight baseline (using the daily SD,
which is conservative), the 14-day trend with its standard error, and the
7-day mood mean and z. Mood uses the demonstration 1–5 scale.

**Self-assessment questions:**

1. `fatigue`: "On a scale of one to five, how tired do you feel right now?
   One is fully rested, two a little tired, three moderately tired, four very
   tired, and five exhausted." This is a **MeBo demonstration scale, not a
   validated instrument.**
2. `dozed_on_task`: "Have you fallen asleep, or nearly fallen asleep, during a task?"
3. `schedule_shift`: "Has your sleep or work schedule shifted in the last week?"
4. `self_harm`: "Have you had any thoughts of harming yourself?" This is
   **asked only when the low-mood rule applies**, and is then required.

**Required inputs:** last night's sleep, the 7-night mean, `fatigue`,
`dozed_on_task`, and `self_harm` when it is asked.

| Rule | Title | Level | Basis | Refs | Condition |
|---|---|---|---|---|---|
| `SL-CONSENSUS` | Sleep below the adult consensus | monitor | published-adapted | C4, S2, E2 | 7-night mean < 7 h |
| `SL-SHORT` | Sleep under six hours | review | prototype | S2, E2 | 7-night mean < 6 h |
| `SL-BASELINE` | Sleep well below personal baseline | review | prototype | S2 | z of the 7-night mean ≤ −2 |
| `SL-TREND` | Sleep falling | monitor | prototype | S2 | 14-day slope ≤ −0.25 h/week and slope + 2·SE < 0 |
| `FT-HIGH` | High self-rated fatigue | review | prototype | S2 | fatigue = 4 |
| `FT-EXHAUSTED` | Exhaustion reported | urgent | prototype | S2 | fatigue = 5 |
| `FT-DOZE` | Fell asleep during a task | urgent | prototype | S2 | dozed_on_task = yes |
| `SC-SHIFT` | Recent schedule change | monitor | prototype | S2 | schedule_shift = yes |
| `MD-LOW` | Low mood | review | prototype | S2, S3 | 7-day mood mean ≤ 2.5, or its z ≤ −2 |
| `MD-SELFHARM` | Thoughts of self-harm | emergency | prototype | S2 | self_harm = yes (conservative safety rule) |

Notes:

- **Everyone is flagged for short sleep.** In the synthetic scenario every
  crew member sleeps about 6 h in flight (E2). That is below the 7 h
  consensus (C4), so `SL-CONSENSUS` fires for all of them. This is exactly
  the NASA-identified risk (S2), shown rather than hidden.
- **Deferring tasks.** "Consider deferring safety-critical tasks until the
  CMO has reviewed" (`FT-EXHAUSTED`, `FT-DOZE`) is an operational precaution
  and a prototype assumption, not a treatment.
- **Self-harm.** The self-harm question and rule are a conservative
  prototype safety measure: any "yes" escalates to emergency. MeBo's persona
  is told to stay calm, keep the person talking, and bring the CMO in.

---

## 6. Access: the same tools for any model, online or offline

The engine lives in `medical/cds/` with no model dependency. The tools
(`medical/tools.mjs`) are defined once, as `{ name, description,
input_schema (JSON Schema), run }`:

| Tool | Does |
|---|---|
| `list_crew` | Crew ids (fictional profiles) |
| `get_crew_health_summary` | Latest readings, baselines and deviations |
| `get_self_assessment_questions` | The applicable questions, in order, with fixed wording |
| `assess_cardiovascular` | Runs workflow 1 |
| `assess_sleep_fatigue` | Runs workflow 2 |
| `search_space_medical_knowledge` | Step 22: offline search of the five NASA/CSA pages, with citations ([nasa-resource-traceability.md](nasa-resource-traceability.md)) |
| `identify_crew_member`, `get_crew_memory`, `begin_medical_check`, `record_crew_memory` | Step 23: the agent workflows and per-astronaut memory ([agent-workflows.md](agent-workflows.md)). Through the tools, the assess tools also reuse still-valid answers and file each result in memory; the rules and their results are unchanged. |

They are reachable in four ways:

- **The model (Gemma 4 on Hugging Face or a local Ollama):**
  `bridge/medical-tools.mjs` offers them to the agent loop in `bridge/llm/`
  with their JSON Schemas unchanged. The permission policy admits them
  explicitly, and `MEBO_DISABLE=medical` removes them. MeBo's persona has a
  section on how to use them: ask the questions verbatim, relay the
  escalation first, and add no thresholds, diagnoses or treatments.
- **HTTP (any model or agent):**
  - `GET /medical/tools` returns the definitions.
  - `POST /medical/tools/<name>` with a JSON body runs one tool.
  - `GET /medical/crew/<id>/assessments/<workflow>/questions` returns the
    questions.
  - `GET /medical/crew/<id>/assessments/<workflow>?chest_pain=no&…` runs an
    assessment.

  All of these are served by the bridge, or by `npm run medical:serve` with
  no bridge at all.
- **CLI:** `npm run medical -- assess ms2 sleep_fatigue '{"fatigue":4,…}'`,
  `… questions`, `… tools`, `… tool <name> '{…}'`.
- **Gemma/Ollama (future):** pass `input_schema` through as function
  definitions, and route calls to `callTool()` or the HTTP endpoint. Not
  built in this step.

All the tools only read and evaluate. None writes, and none accepts a
threshold or rule from the caller. Unknown arguments, unknown questions and
invalid answers are rejected rather than interpreted.

---

## 7. Validation

`test/cds.test.mjs` covers:

- **Normal:** no rule fires on unremarkable values.
- **Concerning:** NEWS2 bands, blood-pressure categories, baseline deviation,
  trends, sleep, fatigue and mood rules.
- **Missing data:** missing required inputs mean `incomplete`, never `none`.
- **Stale data:** the wearable-offline crew member's 3-day-old heart rate is
  not used.
- **Urgent symptoms:** chest pain, breathlessness, fainting, severe blood
  pressure with and without symptoms, dozing on task, and self-harm.
- **Reproducibility:** identical records and `assessment_id`s across runs.
- **Traceability:** every fired rule's references resolve, and its
  observation ids exist in the database.
- **Offline, no LLM:** runs with network access stubbed out, and nothing in
  `medical/` imports a model SDK.
- **Documentation:** every rule appears in this document with its level,
  basis and references.
- **APIs and model adapter:** the HTTP and tool routes, the model's tool
  adapter, and the policy.

---

## 8. Limitations

- **Not clinically validated, and not for astronauts.** C1–C4 are
  terrestrial guidance for the general adult population, or for hospital
  patients (NEWS2). Using them on a healthy, adapted crew in microgravity is
  itself a prototype assumption.
- **Escalation levels are MeBo's.** Every level-to-response mapping is a
  prototype assumption. No rule is `published` end to end.
- **Prototype cutoffs.** The trend slopes (2 bpm and 3 mmHg/week, −0.25
  h/week), the 6 h sleep cutoff, |z| ≥ 2, the mood ≤ 2.5 cutoff, the fatigue
  cutoffs, and the data-sufficiency rules (4 of 7 nights, 50% coverage, 48 h
  freshness) are all illustrative.
- **Demonstration scales.** The fatigue and mood scales are not validated.
  Samn–Perelli could not be verified and is not used.
- **No aggregate early-warning score.** Only NEWS2's pulse and systolic bands
  are used. Its response thresholds could not be verified.
- **Narrow scope.** Two workflows only. There is no medication, no
  diagnosis, no differential, and no integration with other indicators
  (SpO₂, respiratory rate and temperature are not in these workflows).
- **No persistence.** Answers and assessments are not stored, so there is
  no assessment history yet.
- **Synthetic data.** Every result in this prototype describes fictional
  people.
- **The LLM still speaks.** The model relays the results under persona
  instructions. The rules prevent it from *deciding*, but a model could still
  mis-speak; spoken output is not checked against the record.
