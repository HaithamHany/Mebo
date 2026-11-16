# Camera-supported fatigue concern (Step 26D)

After a camera check and the sleep and fatigue questions
([camera-assessment.md](camera-assessment.md)), MeBo combines three kinds of
evidence into one **fatigue concern**: **low**, **moderate**, **high** or
**indeterminate**. The three kinds are:

1. **Sleep history and the personal baseline.** These come from the medical
   database and are read by the sleep rules of the rules engine.
2. **What the astronaut reported.** This means their tiredness rating, any
   dozing on a task and schedule changes, as read by the fatigue rules.
3. **What the camera measured.** This is PERCLOS, sustained eye closures and
   measurement quality ([alertness-assessment.md](alertness-assessment.md)).
   The camera counts only when the measurement is reliable.

The classification lives in `medical/vision/fatigue-concern.mjs`. It is a
pure function, separate from the rules engine.

**What it is not.** It is not a diagnosis, a clinical escalation or a
fitness-for-duty decision. The sleep and fatigue assessment
(`medical/cds/sleep-fatigue.mjs`) is unchanged, and its escalation guidance
still applies word for word. MeBo says that guidance first, before the
concern. The crew medical officer and the flight surgeon make the decisions.

## How the level is decided

```
floor  = rules engine level → none/monitor: low · review: moderate · urgent/emergency: high
         (incomplete, with nothing found at review or above: indeterminate;
          no assessment at all: indeterminate)

camera = used only if: recent (≤ 60 min), a face was seen, eye-measure quality
         good or limited, PERCLOS measured, and the values are plausible
         elevated indicators:  PERCLOS ≥ 15%   ·   ≥ 1 sustained closure (≥ 2 s)
         both, at good quality → high · one (or limited quality) → moderate · none → low

concern = the higher of floor and camera            (the camera can only raise)
          floor indeterminate: the camera's level if moderate or high, else indeterminate
```

These rules are enforced in code and tested:

- **The camera never lowers the concern.** The rules engine's level sets the
  floor. A normal camera reading leaves the concern where the sleep history
  and answers put it, and MeBo says it "does not lower the concern". One test
  runs every rules level against every kind of camera reading.
- **Unreliable data is set aside, never read as normal.** The camera is
  excluded when:
  - eye-measure quality is insufficient;
  - no face was seen;
  - the observation is too old;
  - there is no observation at all;
  - the reading is implausible.

  An excluded camera supports no level, not even "low", and the reason is
  given. If the assessment is also incomplete, the concern is
  **indeterminate**, never low.
- **Extreme values are rejected as implausible.** A PERCLOS above 50%, or a
  single closure longer than 15 s, during a guided check that the person was
  following is more likely a tracking failure than a measurement. Looking
  down, glare and a covered eye all cause this. The reading is set aside and
  does not raise the concern. It is not treated as normal either: the
  questions ask directly about falling asleep, and that answer is read by
  the rules engine.
- **Conflicting evidence is stated, not hidden.**
  - Camera elevated, answers fine: the camera raises the concern. MeBo says
    the two point different ways and that it has taken the more cautious
    view.
  - Answers serious, camera normal: the concern stays where the answers put
    it, and MeBo says so.

## Thresholds and their basis

| Value | Kind | Basis |
|---|---|---|
| Floor mapping from rules engine levels | **Prototype** | MeBo's mapping. The levels themselves are the rules engine's. |
| PERCLOS (P80) ≥ 15% counts as elevated | **Prototype, literature-informed** | PERCLOS rises with drowsiness in laboratory and driving studies (FHWA 1998; Dinges et al. 1998). Abe (2023) reviews the many definitions and devices: no single cut-off is established, and values are not comparable across studies. 15% is MeBo's existing follow-up cue. It is not validated for this webcam, software, population or spaceflight. |
| A sustained closure is ≥ 2 s | **Prototype, literature-informed** | Far beyond normal blink durations (Caffier et al. 2003). Brief sleep episodes are commonly described as lasting up to about 15 s (Hertig-Godeschalk et al. 2020). In MeBo's validation, sustained closures were measured close to the truth. |
| ≥ 1 sustained closure counts as elevated | **Prototype** | One in a one-minute guided observation. |
| High needs both indicators at good quality; limited quality caps the camera at moderate | **Prototype** | Conservative: one weak signal cannot make the concern high. |
| Implausible: PERCLOS > 50%, or a closure > 15 s | **Prototype, literature-informed** | See above. 15 s is the usual upper bound of a brief sleep episode. |
| A camera check older than 60 min is not used | **Prototype** | A one-minute observation describes that moment, not the day. |

None of these thresholds is clinically validated. Every record carries the
threshold values and their basis, so a stored result can always be traced
back to the rules that produced it.

## What the astronaut sees and hears

- **Centre view.** The result opens with a **COMBINED FATIGUE CONCERN ·
  PROTOTYPE** block. It shows:
  - the level and the rules engine's floor;
  - whether the camera raised it, did not raise it, or was not used;
  - every contributor: each rules finding and its source (sleep history,
    self-report, schedule or mood), and each camera indicator with its
    value, its limit and its effect ("raised the concern", "within prototype
    limit", "set aside" with the reason);
  - any conflict between the sources.

  Below it, the rules engine's level and escalation guidance appear in full,
  as before.
- **Side card.** It shows `FATIGUE CONCERN: HIGH · RAISED BY CAMERA` (or
  `· CAMERA NOT USED`) above the rules engine line. It is rebuilt after a
  reload from the stored record.
- **Voice.** MeBo first gives the escalation guidance word for word, then
  the main findings. Then it says: "The camera measures did not change that
  result. Putting your sleep, your answers and the camera together, my
  fatigue concern is moderate. That comes from sleep under six hours… The
  camera was not used, because… That is not a sign that everything is fine.
  This is a prototype measure, not a diagnosis, and it does not change the
  guidance I just gave."

## Memory, provenance and references

`assess_fatigue_concern` files the result in the astronaut's memory file,
under `fatigue_concerns`. The entry holds:

- the level and the floor;
- every contributor;
- the camera status and its values;
- any conflicts;
- the written explanation and the spoken text;
- the thresholds with their basis;
- the limitations;
- the references, including the NASA Human Research Program passage quoted
  verbatim from the knowledge base with its retrieval date;
- **provenance**: the method version, the time computed, the
  `assessment_id`, the assessment's `inputs_sha256` and `dataset_sha256`, and
  the camera `observation_id`.

The entry is marked `affects_assessment: false`. It opens and closes no
clinical concern, and no rule reads it. The conversation note records it in
one line.

## Interfaces (online or offline model)

- **Tool `assess_fatigue_concern`** `{crew_id, assessment_id?}`: one of the
  model-neutral tools in `medical/tools.mjs`, so it works the same for
  either model provider through the bridge, and for any client over
  `POST /medical/tools/assess_fatigue_concern`. It takes no measures or
  thresholds from the caller (`additionalProperties: false`).
- **`GET /medical/crew/:id/fatigue-concern`** returns the latest stored
  concern (read-only).
- **The console.** After `assess_sleep_fatigue`, the console calls the tool
  itself with the new `assessment_id`. No language model is involved.
- **The bridge.** When MeBo started the check, `request_visual_observation`
  returns `sleep_fatigue.fatigue_concern` (level, camera status, spoken text,
  explanation). MeBo is instructed to give the guidance first, then the
  spoken line.

## Tests

`test/fatigue-concern.test.mjs` has 13 tests:

- **Normal observations:** the concern follows the rules, and the camera is
  listed as within limits.
- **Elevated PERCLOS:** raises the concern, and names exactly which
  indicator did and its threshold. The boundary is exact.
- **High:** needs both indicators at good quality; limited quality caps the
  camera at moderate.
- **Never lowers:** every rules level, complete and incomplete, against no
  camera, a normal one, an elevated one, a strongly elevated one and an
  insufficient one.
- **Conflicting evidence**, in both directions.
- **Missing camera data**, and an observation that is too old.
- **Poor tracking:** insufficient quality, closure not detected, missing
  frames, no face. All are rejected, and none counts as "low".
- **Incomplete rules:** indeterminate with a normal camera; raised by a
  reliable elevated one.
- **Extreme values:** PERCLOS 100% with a 60 s closure, PERCLOS 60%, and a
  40 s closure. All are set aside as implausible.
- **Labelling:** every threshold is labelled; the record carries the method,
  references and limitations, and has no diagnosis or fitness vocabulary.
- **End to end:** through the service, tool, HTTP route and memory, with
  provenance and isolation between crew members.
- **The rules engine is unchanged:**
  - the ruleset file hashes to its committed version;
  - the assessment's level, rule outcomes, evidence and escalation are
    identical with and without an elevated camera observation and the
    concern, before and after, for every crew member;
  - the open clinical concerns are identical too.

The browser test (headless Chrome, real MediaPipe) covers:

- a photo with insufficient eye quality, set aside with the floor kept;
- a refused camera, where the concern rests on the rules alone;
- a reliable, elevated observation raising REVIEW to a high concern, with
  the indicators named on screen and by voice;
- the side card, before and after a reload;
- the concern relayed through the bridge when MeBo starts the check.

## Limitations

- **No validation against a reference.** The classification has not been
  compared with a reference measure (PVT, clinician rating) or with
  spaceflight data. Its thresholds are prototype assumptions.
- **A short window.** A one-minute PERCLOS is a snapshot. Looking down,
  reading, glare, dry eyes or eye shape can raise it without any change in
  alertness, which is why MeBo names this possibility when the camera
  disagrees with the answers.
- **Blinks are not used.** The blink rate is not validated (it misses brief
  blinks).
- **Synthetic data.** In the synthetic scenario every crew member's recent
  sleep already triggers REVIEW. With real data the floor would vary.
- **The camera only adds caution.** It can raise the concern, so a false
  camera reading can cause unnecessary concern. It can never cause false
  reassurance.

## References

- Abe, T. (2023). PERCLOS-based technologies for detecting drowsiness:
  current evidence and future directions. *SLEEP Advances*, 4(1), zpad006.
  https://doi.org/10.1093/sleepadvances/zpad006
- Caffier, P. P., Erdmann, U., & Ullsperger, P. (2003). Experimental
  evaluation of eye-blink parameters as a drowsiness measure. *European
  Journal of Applied Physiology*, 89(3–4), 319–325.
  https://doi.org/10.1007/s00421-003-0807-5
- Hertig-Godeschalk, A., Skorucak, J., Malafeev, A., Achermann, P., Mathis,
  J., & Schreier, D. R. (2020). Microsleep episodes in the borderland between
  wakefulness and sleep. *Sleep*, 43(1), zsz163.
  https://doi.org/10.1093/sleep/zsz163 (DOI as listed in Abe 2023's
  reference list).
- Federal Highway Administration (1998). *PERCLOS: A Valid
  Psychophysiological Measure of Alertness as Assessed by Psychomotor
  Vigilance.* Tech Brief FHWA-MCRT-98-006.
- Dinges, D. F., Mallis, M. M., Maislin, G., & Powell, J. W. (1998).
  *Evaluation of Techniques for Ocular Measurement as an Index of Fatigue and
  the Basis for Alertness Management.* NHTSA, DOT HS 808 762.
- NASA Human Research Program, "Risks of Human Spaceflight", section "Risk of
  Inadequate Sleep and Irregular Schedules", https://www.nasa.gov/hrp/risks/,
  stored verbatim in `medical/knowledge/corpus.json`.
