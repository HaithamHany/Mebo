# Camera assessment (Step 26)

MeBo can run a short, guided camera check. It explains what it is about to
observe, asks for the camera, and talks the crew member through four tasks
while the Camera Assessment panel shows live feedback. The result is a
numeric summary of what the camera saw. It is **an observation, not a
diagnosis**, and it never changes an assessment or an escalation level.

## What it does

| Task | Instruction (spoken by MeBo) | Completed when | Times out after |
|---|---|---|---|
| `face_camera` | "Please look straight at the camera." | A face is in view with head yaw within ±15° for 1.5 s | 12 s |
| `natural_gaze` (Step 26B) | "Now please look at the camera naturally for one minute, and blink as you normally would." | The configured window (60 s by default; 20 to 180 s) observed, with the face in view at least 70% of it | Window + 10 s |
| `eyes_closed` | "Please close your eyes for three seconds, then open them." | Eyes read closed for 2 s, then open again ("You can open your eyes now." is spoken at 2 s) | 15 s |
| `head_turn` | "Please turn your head slowly to one side, then to the other side." | Yaw beyond +20° and beyond −20° | 15 s |
| `hold_still` | "Please look at the camera and hold still for five seconds." | A 5 s window with the face in view at least 70% of it | 9 s |

The natural-observation task, added in Step 26B, measures EAR, PERCLOS,
blinks and eye closures with their quality. Its equations, thresholds,
validation and references are in
[alertness-assessment.md](alertness-assessment.md). Observations are now
protocol `face_alertness_v2`; earlier `face_basic_v1` ones are still accepted
and readable. With the default one-minute window, the whole check takes about
two minutes. A task that is not done in time
is recorded as **not completed**, which is a fact about the session, not a
finding. If no face is seen during the first task, MeBo says so and stops.

### What is measured

From each analysed frame (about 15 per second), using MediaPipe Face
Landmarker's 478 landmarks and its blendshapes:

- **Face in view.**
- **Eye opening**, 0 (shut) to 1 (open): `1 − mean(eyeBlinkLeft, eyeBlinkRight)`.
  If blendshapes are missing, it falls back to the eye aspect ratio of the lid
  landmarks.
- **Head orientation**, approximate, from landmark geometry. Yaw is the nose
  offset from the middle of the face; pitch is the same idea vertically; roll
  is the angle of the eye line.
- **Head movement**: nose travel between frames, in units of the face's own
  width (outer eye corner to outer eye corner), per second.

### The summary that is kept

| Field | Meaning |
|---|---|
| `face_visible_ratio` | Share of frames with a face |
| `tasks[]` | Each task: `completed`, `seconds` |
| `blinks` | Closures of 0.5 s or less, outside the instructed eye-closure task |
| `longest_unprompted_eye_closure_s` | Longest closure outside that task |
| `prolonged_unprompted_eye_closures` | Closures of 2 s or longer outside that task |
| `head_yaw_range_deg`, `head_pitch_range_deg` | How far the head turned and nodded over the session (approximate) |
| `hold_still_movement`, `hold_still_steady` | Movement during hold-still, and whether it was under 0.25 face-widths per second |

Closures during the instructed task are the task itself, so they are left out
of the indicators. A frame with no face ends a closure, because the eyes are
unknown then, not closed.

All the limits above (closed below 0.35, blink ≤ 0.5 s, prolonged ≥ 2 s,
facing ±15°, turn ±20°, steady < 0.25, 70% visible) are **prototype
assumptions about camera observation quality**. None of them is a clinical
threshold. They live in one place, `LIMITS` in `src/lib/visual/observe.ts`.

## What it does not do

It does not read fatigue, illness, pain, mood, cardiovascular state or any
psychological condition from a face. Facial appearance cannot diagnose those,
and nothing in the code, the summary, the panel or MeBo's instructions claims
otherwise:

- **No verdicts in the data.** The summary has no level, score or verdict
  field, and the server rejects any field it does not know, so free text such
  as `"diagnosis": "fatigue"` cannot be stored.
- **Factual descriptions only.** The plain-language description is built from
  the numbers alone ("Face in view 97% of 34 seconds. … 6 blinks …"). A test
  checks it for words like fatigue, drowsy, illness, stress, pain or mood.
- **MeBo's instructions forbid inference.** It is told to say only what the
  camera observed, never that it shows fatigue, illness, pain or mood, and
  never to let it change a result.
- **The panel says so.** It labels every result "observation only — not a
  diagnosis".

## The interface (Step 26C)

A check takes the centre of the screen while it runs.

- **Opening.** Starting a check, from the panel or by MeBo, grows the Camera
  Assessment card's frame into a large centre view: a shared framer-motion
  `layoutId`, one continuous movement. The rest of the console stays in place,
  dimmed and softened behind it (`src/ui/medical/CameraStage.tsx`).
- **While it runs.** The centre view shows:
  - the live mirrored preview with the tracked points;
  - the step ("Step 2 of 5 · Natural gaze") and what MeBo has just said;
  - the five-task checklist, with the current task's progress;
  - live feedback on conditions: face in view, distance, facing the camera,
    lighting, tracking speed and eye opening. These use the same limits as
    the measures;
  - a **Stop check** control.
- **When it ends.** The result appears in the same view: a status
  (complete, with good, limited or insufficient quality, or no face
  detected), the key values in plain words, the quality reasons, the
  explanation MeBo speaks, and the suggested next step. Everything is labelled
  "Observation only — not a diagnosis or fitness for duty".
- **Folding back.** **Done**, Escape, or a timeout (45 s for a result, about
  2 s after Stop, 7 s after a refusal or error) folds the view back into the
  card.
- **Afterwards.** The card keeps the latest result: crew member, time,
  status, values and label. After a reload, it reads the most recent stored
  check back from `GET /medical/visual-observations`.

Both the centre view and the card take their wording from one helper
(`src/ui/medical/visualResult.ts`), so they cannot disagree.

## From camera check to sleep and fatigue assessment (Step 26C)

A camera check now leads into a health assessment rather than ending at the
eye measurements. When the check ends, the console continues into the
existing sleep and fatigue workflow (`src/lib/visual/followup.ts`). It uses
only the existing local tools, so it is the same on either model provider,
or with no model at all:

1. **What is already known.** `begin_medical_check` (sleep_fatigue) returns
   the structured questions still to ask, in the rules engine's wording, with
   answers given recently removed.
2. **Consent.** MeBo asks "…a few short questions about your sleep and how
   tired you feel. Is that all right?" A "no", or no clear answer, means
   **declined**. Nothing is assessed. MeBo says that this is not a sign that
   everything is fine, and a note is filed in memory.
3. **The questions.** MeBo asks each one in its voice. Answers can be spoken
   or chosen on screen (Yes/No; 1–5 with the scale's labels; Skip). Spoken
   answers are read by fixed rules (`interview.ts`), never by a model:
   - **Unclear answers are not guessed.** "I don't know", or two numbers at
     once, are asked again once, then left unanswered.
   - **MeBo's own question is never taken as an answer.** It only listens
     after it has finished speaking.
4. **The assessment.** `assess_sleep_fatigue` runs unchanged, with the
   answers. It files the result and the answers in the crew member's memory.
   **Nothing from the camera is sent to it.**
5. **The result.** The centre view leads with the rules engine's level and
   escalation guidance, word for word. Then it shows:
   - the findings, next steps and anything missing; an incomplete assessment
     carries the engine's own "not reassurance" text;
   - recorded sleep and self-report (from `/medical/crew/:id/alertness`);
   - the camera result, marked "supplementary, did not change this result";
   - the NASA source.

   MeBo speaks the guidance first, then the main findings, then that the
   camera did not change the result. The side card keeps "SLEEP & FATIGUE
   (RULES): level · status · time".
6. **Memory.** A one-line note links the camera observation and the
   assessment, for example "Camera check (limited, vis-…) followed by the
   sleep and fatigue check: REVIEW, complete (as-…)".

**When the camera could not contribute** (insufficient eye-measure quality,
no face, a refused camera, an error), MeBo says so before the questions: "…so
the camera adds nothing to this check. That does not mean everything is fine.
The questions will still tell us how you are." **After Stop**, nothing
continues; the person ended it.

**Continuity.** Answers given so far are kept in this browser for 30 minutes
(`localStorage`, cleared once the assessment is filed or declined). After a
reload or Stop, the card shows "Sleep questions not finished · Resume", and
resuming asks only what is still unanswered. After a reload, the card shows
the latest camera check with the sleep and fatigue assessment that followed
it, read back from the medical service.

**When MeBo starts the check** (`request_visual_observation`), the page runs
the questions and the assessment too, and the tool returns them as
`sleep_fatigue`: the level, guidance, missing items, or declined. MeBo's
instructions are to relay the guidance word for word, not to ask the
questions again, and to say plainly when nothing can be concluded.

**Safety.** The camera is supplementary evidence only. It is never passed to
the assessment, and the rules engine alone decides the level, the findings
and the escalation. `test/camera-followup.test.mjs` checks that an extreme
camera observation leaves the assessment identical for every crew member. No
diagnosis or fitness-for-duty judgement is made anywhere.

### The combined fatigue concern (Step 26D)

After the assessment, the console calls `assess_fatigue_concern`. This
combines the rules engine's level (as a floor), sleep history, the
self-report and, only when reliable, the camera's PERCLOS and sustained
closures, into low, moderate, high or indeterminate. The concern leads the
result in the centre view and the side card, and MeBo says it after the
guidance. See [fatigue-concern.md](fatigue-concern.md).

## Where it fits in the medical workflows

```
 panel "Start check"            MeBo: request_visual_observation(crew_id)
        │                                   │ bridge asks the page (WebSocket)
        ▼                                   ▼
 src/lib/visual/assessment.ts — the guided check, in MeBo's Piper voice
   face.ts (MediaPipe, local) → observe.ts (numbers) → summary
        │ POST /medical/visual-observations   (summary only)
        ▼
 medical/vision/observations.mjs — validates the exact shape
        ▼
 medical/memory — the crew member's memory file, `observations`
        ▲
 get_visual_observations · begin_medical_check.supplementary_observations
```

- **`request_visual_observation(crew_id)`** (bridge tool): MeBo offers the
  check during a conversation and runs it only if the crew member agrees. The
  model supplies only who the check is for; the page runs the check, files
  the result and returns it. It is not offered when the camera is disabled
  (`MEBO_DISABLE=camera`).
- **`get_visual_observations(crew_id)`** (model-neutral, in
  `medical/tools.mjs`): reads recent observations with their descriptions.
- **`begin_medical_check`** includes the latest observation from the last
  hour under `supplementary_observations`, marked `affects_assessment:
  false`. If there is none, it notes that a check can be offered.
- **Recording is not a tool.** Only the browser's measured summary can be
  filed (`POST /medical/visual-observations`). No model can invent an
  observation.

### Clinical decisions stay with the rules engine

Observations are stored in memory, never in the SQLite database. The
assessment functions never read them. They open and close no concerns, and no
tool lets them be passed into an assessment (`additionalProperties: false`).
`test/visual-observation.test.mjs` checks this for every crew member, both
workflows, with full and empty answer sets. It files the most alarming
observation the gate accepts (every task failed, 40 prolonged closures, face
30% visible) and checks that the level, evidence, rule outcomes, escalation
guidance, missing items and open concerns are identical to the same
assessment without it.

## Privacy and offline operation

- **Everything runs locally.** The MediaPipe WebAssembly runtime is the copy
  `npm start` vendors into `public/mediapipe/`, shared with hand tracking. The
  model `face_landmarker.task` (float16, ~3.7 MB, sha256
  `64184e22…0bc9ff`) is fetched once by `npm run face:download` from Google's
  versioned MediaPipe model path into `public/models/mediapipe/`, which is
  gitignored. Both are served from this origin.
- **Frames are analysed and dropped.** No frame is drawn to a canvas for
  storage, encoded, kept or sent. The panel's preview draws the live stream
  directly. Only the summary leaves the browser, and only to the local bridge.
- **No recording.** The camera opens for a check and closes when the check
  ends, is stopped (panel Stop, or Escape), fails or is refused. It uses the
  shared, reference-counted camera (`src/lib/camera.ts`), so hand tracking and
  the camera blade keep working alongside it.
- **MediaPipe's usage logging is refused.** `@mediapipe/tasks-vision` 1.0.1
  posts usage reports to `https://odml.pa.googleapis.com/v1/log` every minute,
  for every task including the existing hand tracking, and has no option to
  turn this off. The page's CSP allows `https:` (needed for model downloads),
  so it cannot single out that host. `src/lib/visual/no-telemetry.ts` makes the
  page's `fetch` refuse that one endpoint, after which MediaPipe's logger stops
  itself. The offline browser test found this request; with the guard in
  place, the camera stack makes no outside request at all.

## Independence from the model

The check, its wording and its judging are fixed code (`src/lib/visual/`). It
runs from the panel with no model at all. The tool definitions are plain JSON
Schema, and the endpoints are plain HTTP:

- `POST /medical/visual-observations`: `{crew_id, observation}`
- `GET /medical/crew/:id/visual-observations`
- `POST /medical/tools/get_visual_observations`

Either model provider reaches them through the same tools, and the bridge
starts a check by sending the page a `visual` request.

## Validation

- **`test/visual-observation.test.mjs`** (16 tests): per-frame measurements
  (no face, yaw sign and symmetry, blendshape and lid-based eye opening); each
  task's completion and timeouts; the summary (instructed versus unprompted
  closures, blinks, a moving face, an empty room); the gate rejecting extra
  fields, free text, wrong types, unknown tasks and out-of-range values;
  storage isolation; the read tool; supplementary context; and the guarantee
  above.
- **`test/medical-agent.test.mjs`**: through the real bridge and Agent SDK,
  with a scripted CLI and a stand-in page:
  - the check is requested from the page with only a `crew_id`;
  - the summary is filed for Novak only and opens no concern;
  - the tool result carries no level or escalation;
  - a refused camera files nothing;
  - with the camera disabled the tool is not offered.
- **A headless Chrome run** (real MediaPipe on the GPU, a public-domain
  portrait as a fake camera, every outside request blocked), 32 checks:
  - **Panel:** the camera is off before a check, and there are no
    diagnostic-sounding placeholders.
  - **Tracking:** a live preview with 478 tracked landmarks at about 12 fps on
    the GPU delegate, and a live readout of face, eyes and head.
  - **The photograph's check:** the still-face tasks were completed and the
    motion tasks honestly were not.
  - **Results:** the summary was filed and shown as an observation, and the
    camera shut down after every run (stream closed, every track ended,
    no holds left).
  - **Missing face:** the panel said so, and the check stopped after the
    first task.
  - **Permission refused:** reported as refused, nothing filed, no camera
    hold left behind.
  - **Started by MeBo:** a check started through the bridge was relayed as
    "NOVAK: Face in view …".
  - **Offline:** the model and runtime came from localhost and nothing else
    was requested. The only POSTs were summaries of up to 544 bytes, with no
    image data.

## Limitations

- **Orientation is approximate.** Yaw and pitch come from 2D landmark
  geometry, not a calibrated head pose. Pitch is reported only as a range.
  Glasses, beards, strong side light, low resolution or a partly hidden face
  reduce accuracy.
- **Eye opening comes from blendshapes.** It varies with the person, the
  lighting and the camera angle. The closed threshold is a prototype
  assumption, not validated.
- **Turning is judged in both directions together.** The head-turn task
  accepts either order and does not check left versus right separately.
- **A photograph completes the still tasks.** A printed photo or a still
  image completes `face_camera` and `hold_still`. There is no liveness check,
  and none is claimed.
- **One face only, and no identity check.** The check is filed for the crew
  member selected on the console, or the one MeBo names. It does not check
  who is in front of the camera.
- **The motion tasks were tested with synthetic landmarks.** The eye-closure
  and head-turn tasks were verified with synthetic landmark sequences
  (`test/visual-observation.test.mjs`), not with a live person. A real person
  should try the check before it is relied on.
- **A missing model disables only the check.** If `face:download` has not
  run, the panel reports that the face model is missing; nothing else is
  affected.
- **The Google Fonts stylesheet is still requested.** The interface's
  stylesheet (`fonts.googleapis.com`), which predates this step, is still
  requested online. Offline it fails and the interface falls back to system
  fonts.
