# Visual alertness observation (Step 26B)

MeBo's guided camera check ([camera-assessment.md](camera-assessment.md))
includes a natural-observation window. During it MeBo measures, from facial
landmarks:

- the eye aspect ratio (EAR);
- PERCLOS, the share of time the eyes are at least 80% closed;
- blinks and eye-closure durations;
- how trustworthy each of those measurements is.

It then sets the results beside the crew member's recorded sleep, their own
tiredness rating and their last sleep and fatigue assessment, in an
**observational summary**.

**Nothing here is a diagnosis or a fitness-for-duty judgement.** Camera
measures never change an assessment, a concern or an escalation level. The
sleep and fatigue assessment (the rules engine,
[clinical-decision-support.md](clinical-decision-support.md)) stays
authoritative. The strongest step this feature ever suggests is to run that
assessment.

Step 26D adds a separate, labelled classification beside the rules engine:
the **camera-supported fatigue concern** ([fatigue-concern.md](fatigue-concern.md)).
A reliable camera observation can raise that concern, but never lower it, and
it still changes no assessment, clinical concern or escalation level.

This document marks every element as one of three kinds:

- **Research**: published and peer-reviewed, or an official definition.
- **Prototype**: MeBo's own implementation choice. It is not validated, and
  it is documented so it can be challenged.
- **Measured here**: what MeBo's own browser validation found (below).

## Why it matters for spaceflight

From NASA's Human Research Program, stored verbatim in MeBo's offline library
([nasa-resource-traceability.md](nasa-resource-traceability.md)):

> **Risk of Inadequate Sleep and Irregular Schedules.** "Space crews
> experience multiple hazards simultaneously. Stressors include chronic sleep
> loss, constant work demands, and irregularities in their internal biological
> clocks. Understanding how to reduce the effects of these stressors on crew
> health and safety is an ongoing area of research." (NASA HRP, *Risks of
> Human Spaceflight*, https://www.nasa.gov/hrp/risks/, page last updated
> 21 July 2026, retrieved 14 November 2026; passage
> `S2:risk-of-inadequate-sleep-and-irregular-schedules`)

> **Risk of Behavioral Changes and Psychiatric Disorders.** "Isolation,
> radiation, distance from Earth, and other intense space stressors may all
> take a toll on the mental health of the crew. Ongoing research seeks to
> better understand and quantify these psychological risks." (same page;
> passage `S2:risk-of-behavioral-changes-and-psychiatric-disor`)

> **Isolation and Confinement.** "Behavioral responses occur among groups of
> people isolated and confined in a small space over a long period of time.
> Crews must be carefully chosen, trained, and supported to ensure they can
> work effectively as a team for months or years in space." (NASA HRP, *5
> Hazards of Human Spaceflight*, https://www.nasa.gov/hrp/hazards/, page last
> updated 12 June 2026; passage `S1:isolation-and-confinement-2`)

The observational summary returns the first two passages with every result
(`nasa_background`).

Two peer-reviewed spaceflight studies add context:

- **Barger et al. (2014)** found sleep deficiency common in astronauts
  before, during and after spaceflight.
- **Basner et al. (2013)** found protracted crew hypokinesis and changes in
  sleep duration and timing during the 520-day Mars mission simulation.

The established reference measure of vigilance under sleep loss is the
psychomotor vigilance test (PVT), Basner & Dinges (2011). PERCLOS earned its
standing by tracking PVT lapses in laboratory studies (FHWA 1998; Dinges et
al. 1998). A webcam PERCLOS from MeBo has **not** been compared with a PVT.

## The measurements

### Eye aspect ratio (EAR) — research

Soukupová & Čech (2016) define, from six landmarks per eye (p1 and p4 the eye
corners; p2/p6 and p3/p5 the upper and lower lid pairs):

```
EAR = ( ‖p2 − p6‖ + ‖p3 − p5‖ ) / ( 2 ‖p1 − p4‖ )
```

EAR is roughly constant while the eye is open and falls toward zero as it
closes. It does not depend on the face's size or position in the picture. x is
corrected for the frame's aspect ratio before distances are taken.

**Landmark indices (prototype mapping).** These are the indices commonly used
with MediaPipe's Face Mesh topology (Kartynnik et al. 2019). MediaPipe itself
does not define an EAR.

| Eye | p1 | p2 | p3 | p4 | p5 | p6 |
|---|---|---|---|---|---|---|
| Person's right (image left) | 33 (outer corner) | 160 | 158 | 133 (inner corner) | 153 | 144 |
| Person's left | 362 (inner corner) | 385 | 387 | 263 (outer corner) | 373 | 380 |

The frame's EAR is the mean of both eyes. Each eye is also kept separately.

### Per-session calibration — prototype

People's open-eye EAR differs (eye shape, glasses, camera angle), so MeBo
calibrates each session with two points:

- `EAR_open`: the larger of the 90th percentile of EAR while facing the
  camera and the 90th percentile during the natural window. These are kept
  separate so that eyes drooping for the whole window cannot teach the
  calibration that drooping is "open".
- `EAR_closed`: the median EAR during the instructed eye closure, using only
  frames the blendshape also reads as closed. If that task gives no closed
  frames, the session is uncalibrated and `EAR_closed` is taken as 0.

```
openness = clamp( (EAR − EAR_closed) / (EAR_open − EAR_closed), 0, 1 )
```

### PERCLOS — research definition, prototype implementation

PERCLOS is "the proportion of time in a minute that the eyes are at least 80
percent closed" (FHWA 1998, describing the measure from Wierwille et al.
1994). Abe (2023) reviews current evidence and the variety of
implementations.

```
PERCLOS_P80 = Σ dt(valid frames with openness ≤ 0.2)  /  Σ dt(valid frames)
```

- **Valid frames only.** A frame counts only if a face is found, both EARs
  exist, |yaw| ≤ 30° and the outer eye corners are at least 80 px apart.
  Missing frames are left out of both numerator and denominator.
- **Time-weighting.** Each frame stands for the time until the next. Before a
  gap longer than 0.25 s it stands only for its own frame interval, so a
  camera stall is neither "open" nor "closed".
- **Two methods, reported separately.** A second PERCLOS from MediaPipe's
  `eyeBlink` blendshapes, calibrated the same way, is reported as
  `perclos_blendshape`. The two are never merged.

The window defaults to 60 s, matching the per-minute definition. It is
configurable from 20 to 180 s with `VITE_ALERTNESS_WINDOW_S`, or
`__mebo.visual.setWindow(seconds)` in the browser.

### Blinks and closures — prototype

- **A closure episode** is consecutive valid frames with openness below 0.5,
  never bridged across a missing frame or a gap. It counts only if the eyes
  reach at least 80% closed somewhere in it, the P80 criterion. An episode
  cut off by missing frames or by the end of the window has an unknown
  duration and is not counted.
- **A blink** is an episode lasting 0.5 s or less. Spontaneous blinks
  typically last a few hundred milliseconds, and blink duration lengthens with
  drowsiness (Caffier et al. 2003).
- **The blink rate** is blinks per minute of valid time. People blink about
  17 times a minute at rest, with wide variation (Bentivoglio et al. 1997). A
  measured rate below 2 a minute is treated as missed blinks: MeBo says "I
  could not count your blinks reliably" rather than speaking it as a rate.
- **Prolonged closures** are episodes of 2 s or longer.

### Measurement quality — prototype

Every observation carries a grade and its reasons, from a fixed vocabulary.

| Reason | When |
|---|---|
| `short_observation` | Under 20 s of valid eye tracking |
| `below_window` | Valid time under 80% of the configured window |
| `very_low_frame_rate` / `low_frame_rate` | Under 8 / under 20 analysed frames per second; quick blinks can be missed below 20 |
| `missing_frames` | Valid share of the window under 80% |
| `head_turned` / `face_too_small` | Over 10% of frames excluded for yaw over 30°, or eye corners under 80 px apart |
| `eye_asymmetry` | Over 10% of frames with one eye open and the other shut (openness differing by more than 0.6) |
| `no_closed_calibration` | No instructed eye closure to calibrate against |
| `closure_not_detected` | The instructed eye closure ran, but closed eyes were never seen |
| `low_agreement` | EAR and blendshape agree on open versus closed on under 80% of frames |
| `too_dark` / `too_bright` | Mean face-region brightness under 40 / over 220 (0–255) |
| `illumination_changed` | Face-region brightness range over 60 during the window |

- **Insufficient:** any of `short_observation`, `very_low_frame_rate` or
  `closure_not_detected`. Then no PERCLOS and no blink rate are reported at
  all; the gate refuses an insufficient observation that carries them.
- **Limited:** any other reason.
- **Good:** none.

`closure_not_detected` exists because of the validation below. With glasses
and glare, or one eye covered, MediaPipe kept reporting open eyes even while
the eyes were closed. A "PERCLOS 0%" in that situation would be false
reassurance.

MediaPipe's Face Landmarker for the web does not return a per-frame
confidence score for its landmarks. Tracking confidence is therefore
expressed through these proxies:

- detection under its presence threshold (0.5);
- face size;
- head angle;
- left/right consistency;
- agreement between the two eye-state methods;
- frame rate;
- gaps;
- lighting.

Brightness is sampled about four times a second: the face's bounding box is
drawn into a 16×16 canvas, averaged and cleared. No image is kept.

### Thresholds at a glance

| Value | Kind | Source |
|---|---|---|
| EAR formula | Research | Soukupová & Čech 2016 |
| P80 (at least 80% closed) | Research definition | FHWA 1998; Wierwille et al. 1994 |
| 60 s window | Research convention | FHWA 1998 (per minute) |
| Two-point calibration; open = larger P90 | Prototype | This document |
| Closure episode at openness < 0.5, reaching P80 | Prototype | This document; validation below |
| Blink ≤ 0.5 s; prolonged ≥ 2 s | Prototype, literature-informed | Caffier et al. 2003 (blink durations) |
| Plausible blink rate ≥ 2/min | Prototype, literature-informed | Bentivoglio et al. 1997 (about 17/min at rest) |
| Valid-frame rules, quality reasons and limits | Prototype | This document |
| Face size ≥ 80 px | Prototype, measured here | Validation below |
| Blendshape references 0.12 open / 0.73 closed | Prototype, measured here | Validation below |
| PERCLOS follow-up cue 0.15 | **Prototype only** | Orders suggestions; never sets a level (Abe 2023 describes varying cut-offs) |

## Does MediaPipe support reliable eye-state estimation? Validation

The tests ran in headless Chrome on the GPU delegate, using real MediaPipe
Face Landmarker and the real `observe.ts`. Photographs were fed as a fake
camera. Scripts and raw results are kept outside the repository.

### 1. Real open versus real closed eyes (still photographs)

Four photographs from Wikimedia Commons were used, each cropped to the face:

- a NASA portrait (public domain);
- an open-eyed portrait and an eyes-closed photo of the same person
  (CC BY-SA 3.0; photographers Manuel Archain and Kat Walsh);
- an eyes-closed portrait (CC0; photographer Toa Heftiba).

| Photo | Eyes | EAR (R / L) | eyeBlink |
|---|---|---|---|
| NASA portrait | Open | 0.300 / 0.301 | 0.08 |
| Portrait, person A | Open | 0.272 / 0.280 | 0.12 |
| Portrait, person A (wider shot) | Open | 0.261 / 0.279 | 0.15 |
| Person A speaking | Closed | **0.030 / 0.036** | **0.71** |
| Portrait, person B | Closed | **0.024 / 0.030** | **0.75** |

**Finding:** both EAR and the blendshapes separate real open and closed eyes
clearly, by a factor of about 8–12 on EAR.

- Real closed eyes score about 0.7 on `eyeBlink`, not 1. A fixed "≥ 0.8" rule
  would never count one, so the blendshape method is calibrated too.
- The same photos placed whole into the frame, with the outer eye corners
  55–83 px apart, were **not detected at all**. At 211 px and above,
  detection was 100%. Hence the 80 px floor and the "sit closer" advice.

### 2. Painted eyelids are not valid test material

Painting the eyes shut on a photograph (skin-coloured fill plus a lash line,
placed from MediaPipe's own eye contour) moved EAR only from 0.302 to 0.231,
and the blendshape from 0.92 open to 0.83. MediaPipe's eye model did not
treat paint as a closed lid. Synthetic image edits must not be used to
validate closure detection. Every closure result below uses real eyelids.

### 3. Real eyelids over time: known-truth scenarios

The camera switched between the open and closed photographs of the same
person. The closed photo was aligned by a similarity transform on the eye
corners (scale 0.99, rotation 3.0°, residual 3–4 px), so each switch changes
mainly the eyelids. The protocol was 3 s facing the camera, a 30 s natural
window, then 3 s of instructed closure. About 19 frames per second were
analysed.

| Scenario | Truth | Measured | Quality |
|---|---|---|---|
| Two 3 s closures | PERCLOS 0.20, 2 prolonged | **PERCLOS 0.17, 2 prolonged**, longest 4.1 s | limited (frame rate) |
| Blinks 0.3 s every 3 s | 10 blinks, PERCLOS 0.10 | 0 blinks, PERCLOS 0 → spoken as "could not count your blinks reliably" | limited (frame rate) |
| Blinks 0.2 s every 3 s | 10 blinks, PERCLOS 0.07 | 0 blinks, PERCLOS 0 → same | limited (frame rate) |
| Blinking with glasses and glare | 10 blinks | Closure never seen → **nothing reported** | insufficient (`closure_not_detected`) |
| Blinking, one eye covered | 10 blinks | **Nothing reported**; agreement 0.53 | insufficient (`closure_not_detected`, `low_agreement`) |
| Blinking, dim light (35%) | — | Calibrated; PERCLOS 0.05 | limited (`too_dark`) |
| Blinking, light changing 35% → 160% | — | PERCLOS 0.04 | limited (`illumination_changed`) |
| A third of each 3 s with no frames | — | **Nothing reported** | insufficient (`missing_frames`, `closure_not_detected`) |
| 10 s observation | — | **Nothing reported** | insufficient (`short_observation`) |

In an earlier run, before the "must reach 80% closed" rule, lagging landmarks
turned some blinks into multi-second partial closures. The rule removed those
spurious prolonged closures, and the real ones were still found.

### What this supports, and what it does not

- **Supported:**
  - **Eye state:** real open versus closed eyes, with the face large enough,
    facing the camera and visible.
  - **Sustained closures:** closures of 2–3 s or more, and PERCLOS driven by
    them.
  - **Flagging unreliable measurements:** dim or changing light, dropped
    frames, a short observation, glasses or occlusion that hide closures,
    small or turned faces.
- **Not supported:**
  - **Brief blinks (0.2–0.3 s):** these were mostly missed. Likely causes are
    MediaPipe's video-mode temporal smoothing and the roughly 19 fps reached
    headless; it is unresolved without real blinking video at 30 fps. **The
    blink rate is therefore not validated** and every explanation says so.
  - **Glasses with glare, or a covered eye:** closures were not registered,
    which is why such sessions report nothing.
- **Never tested:**
  - a live person;
  - real spaceflight lighting, or a population with varied eye shapes;
  - comparison with a PVT or any clinical reference.

**Bottom line:** the camera can support observations about sustained eye
closure, in good conditions, with the quality stated. It cannot by itself
establish drowsiness, a diagnosis or fitness for duty.

### Unit tests with known truth (`test/alertness.test.mjs`, 21 tests)

These use synthetic landmark sequences, which check the arithmetic and logic
exactly:

- **The basics:** EAR's formula and invariance, and the landmark indices.
- **Blinking:** normal blinking (15 a minute, 0.2 s each; rate, duration and
  PERCLOS within tolerance of the truth).
- **Closures:** prolonged closures (PERCLOS 12.5%), and partial closure
  (70% closed is not P80, 85% is).
- **Lost or degraded tracking:** missing frames (excluded, never bridged), a
  camera stall, one-eye occlusion, EAR/blendshape disagreement.
- **Lighting:** dim and changing light.
- **Too little to measure:** insufficient duration, no calibration, an
  invisible instructed closure, a turned head, a small face, low and very low
  frame rates.
- **Configuration and words:** the configurable window, the shared quality
  vocabulary, and the gate rejecting free text, fitness-for-duty fields,
  unknown reasons and rates from an insufficient measurement.
- **Wording:** explanation wording, and the implausible-blink-rate rule.
- **Follow-ups and the summary:** follow-ups, and the summary's content and
  isolation.
- **The guarantee below.**

## The observational summary

`get_alertness_summary(crew_id)`, also available as `GET
/medical/crew/:id/alertness`, is model-neutral. It returns:

- **`camera`:** the latest natural-observation measures, their quality and
  the spoken explanation;
- **`sleep_history`:** from the medical database (synthetic): last night,
  7-day mean, pre-flight baseline;
- **`self_report`:** the crew member's last 1–5 tiredness answer and "dozed on
  task" answer, with their age. The scale is MeBo's demonstration scale, not
  a validated instrument, and the summary says so;
- **`last_rule_assessment`:** the sleep and fatigue assessment's own level,
  quoted, plus open concerns;
- **mission context**;
- **`context`:** one factual line per source, each naming where it comes
  from;
- **`follow_up`:** suggested next steps, most relevant first;
- **`nasa_background`**, **`limitations`** and **`authority`**: "The sleep
  and fatigue assessment (the rules engine) is authoritative … does not judge
  fitness for duty — that decision belongs to the crew medical officer and
  the flight surgeon."

The follow-ups are fixed suggestions, never clinical instructions:

1. **Offer the sleep and fatigue check.** Its prompt ends "its rules decide
   what happens next". It is offered when:
   - a sleep and fatigue concern is open;
   - camera measures reach the prototype cue (PERCLOS ≥ 0.15, or a prolonged
     closure, with usable quality);
   - the crew member reported tiredness of 4 or more, or dozing on task;
   - or no sleep and fatigue assessment has run in 24 hours.
2. **Ask the tiredness question**, using the rules engine's exact wording,
   when no recent rating exists.
3. **Repeat the camera check**, with advice for improving the conditions,
   when quality was not good.

After a check started from the panel, MeBo speaks the explanation (what was
measured, the quality and the limits), then the first follow-up. After a
check MeBo itself started, its reply relays the same text.

### The guarantee: camera metrics cannot decide anything

- **It has no levers.** The summary has no level, score, escalation or
  fitness field of its own. The only `level` it contains is the rules
  engine's, quoted. The gate rejects any such field in an observation.
- **No assessment reads it.** Observations live in memory, and the
  assessment functions never read them.
- **Tested directly:** with the most extreme observation the gate accepts
  (PERCLOS 1.0, 30 prolonged closures), the sleep and fatigue assessment's
  level, rule outcomes, evidence and escalation, and the open concerns, are
  identical to those without it. This holds for every crew member, with full
  and empty answers. The summary is read-only (the memory file is unchanged
  by reading it). With no answers, the assessment stays incomplete: the
  camera cannot complete it.

## Privacy

Processing is fully local, as in Step 26: the local model and runtime, no
uploads, no recordings, and MediaPipe's usage logging refused in-page. In the
offline browser test, only numeric summaries were posted, the largest 1,086
bytes, and the camera stack made no outside request.

## Limitations

- **Not clinically validated.** Validated on photographs and synthetic data,
  not a live person, a spaceflight setting or a clinical reference (PVT).
  Every rate is an observation with stated quality, never a finding.
- **The blink rate is not validated** and may undercount; brief blinks were
  mostly missed in validation.
- **Glasses with glare, an eye covered, or poor tracking** make closures
  invisible to MediaPipe. MeBo then reports nothing rather than 0%.
- **A one-minute window gives an imprecise rate.** Published PERCLOS work
  uses minute-by-minute measures over longer periods.
- **Looking down, reading, screen glare, dry eyes or eye shape** change these
  measures without any change in alertness.
- **Head angle, face size and lighting** are handled by exclusion and
  flagging, not correction.
- **A photograph completes the still tasks.** There is no liveness check.

## References

**Peer-reviewed** (each DOI resolved and checked against Crossref):

- Abe, T. (2023). PERCLOS-based technologies for detecting drowsiness:
  current evidence and future directions. *SLEEP Advances*, 4(1), zpad006.
  https://doi.org/10.1093/sleepadvances/zpad006
- Barger, L. K., Flynn-Evans, E. E., Kubey, A., et al. (2014). Prevalence of
  sleep deficiency and use of hypnotic drugs in astronauts before, during, and
  after spaceflight: an observational study. *The Lancet Neurology*, 13(9),
  904–912. https://doi.org/10.1016/S1474-4422(14)70122-X
- Basner, M., & Dinges, D. F. (2011). Maximizing sensitivity of the
  psychomotor vigilance test (PVT) to sleep loss. *Sleep*, 34(5), 581–591.
  https://doi.org/10.1093/sleep/34.5.581
- Basner, M., Dinges, D. F., Mollicone, D., et al. (2013). Mars 520-d mission
  simulation reveals protracted crew hypokinesis and alterations of sleep
  duration and timing. *PNAS*, 110(7), 2635–2640.
  https://doi.org/10.1073/pnas.1212646110
- Bentivoglio, A. R., Bressman, S. B., Cassetta, E., et al. (1997). Analysis
  of blink rate patterns in normal subjects. *Movement Disorders*, 12(6),
  1028–1034. https://doi.org/10.1002/mds.870120629
- Caffier, P. P., Erdmann, U., & Ullsperger, P. (2003). Experimental
  evaluation of eye-blink parameters as a drowsiness measure. *European
  Journal of Applied Physiology*, 89(3–4), 319–325.
  https://doi.org/10.1007/s00421-003-0807-5

**Workshop paper, preprint and technical reports** (not journal articles):

- Soukupová, T., & Čech, J. (2016). Real-Time Eye Blink Detection using
  Facial Landmarks. *21st Computer Vision Winter Workshop*, Rimske Toplice,
  Slovenia. https://vision.fe.uni-lj.si/cvww2016/proceedings/papers/05.pdf
- Kartynnik, Y., Ablavatski, A., Grishchenko, I., & Grundmann, M. (2019).
  Real-time Facial Surface Geometry from Monocular Video on Mobile GPUs.
  arXiv:1907.06724 (MediaPipe Face Mesh). https://arxiv.org/abs/1907.06724
- Federal Highway Administration, Office of Motor Carrier Research and
  Standards (1998). *PERCLOS: A Valid Psychophysiological Measure of
  Alertness as Assessed by Psychomotor Vigilance.* Tech Brief
  FHWA-MCRT-98-006. https://trid.trb.org/view/498744. Its authorship is often
  given as "Dinges & Grace"; MeBo could not confirm that, so it is cited by
  agency.
- Dinges, D. F., Mallis, M. M., Maislin, G., & Powell, J. W. (1998).
  *Evaluation of Techniques for Ocular Measurement as an Index of Fatigue and
  the Basis for Alertness Management.* NHTSA, DOT HS 808 762. This is the
  study the tech brief summarises.
- Wierwille, W. W., Ellsworth, L. A., et al. (1994). *Research on
  Vehicle-Based Driver Status/Performance Monitoring.* NHTSA, DOT HS 808 247.
  https://rosap.ntl.bts.gov/view/dot/2578. Cited by FHWA (1998) as the origin
  of the P80 PERCLOS metric.

**NASA:** the three Human Research Program passages quoted above, stored
verbatim with their retrieval details in `medical/knowledge/corpus.json`.
