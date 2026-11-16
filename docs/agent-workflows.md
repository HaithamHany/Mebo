# MeBo agent workflows and persistent memory

Step 23. How MeBo runs a medical check in natural conversation, what it
remembers about each astronaut, and how both stay inside the rules set by
the earlier steps.

> **Principle.** The model drives the conversation; the tools supply
> everything it may say about health, each from one authoritative place.
> MeBo invents no measurement, threshold, diagnosis or instruction, and
> conversational memory never changes a clinical decision.

---

## 1. Architecture

```
 astronaut ─ voice ─ bridge ─ Gemma 4 (Hugging Face or local Ollama)
                         │ tool calls (bridge/medical-tools.mjs, bridge/llm/)
                         ▼
              medical/tools.mjs — 10 tools, one definition, also on HTTP and the CLI
                         │
     ┌───────────────────┼─────────────────────────┬──────────────────────┐
     ▼                   ▼                         ▼                      ▼
 medical/workflows.mjs  medical/cds/          medical/knowledge/     medical/memory/
 identify · route ·     rules engine           NASA/CSA library      one JSON file per
 begin · run            (Step 20)              (Step 22)             astronaut (Step 23)
     │                   │
     ▼                   ▼
 medical/service.mjs ── SQLite — the only source of measurements (Step 18)
```

Each kind of information comes from exactly one place:

| What | Where it comes from | Never from |
|---|---|---|
| Measurements (HR, BP, sleep, mood…) | SQLite, via the service | Memory, the model |
| Findings, levels, escalation | The rules engine | Memory, the library, the model |
| Questions and their wording | The fixed question set | The model |
| Spaceflight background | The NASA/CSA library, verbatim | The model's own knowledge |
| Continuity (symptoms, past checks, open concerns) | The astronaut's memory file | Another astronaut's file |

Everything below `medical/` is LLM-independent. The bridge's model (Gemma 4,
on Hugging Face or a local Ollama — [llm-providers.md](llm-providers.md))
reaches it through the tool adapter. Any other client can use:

- `POST /medical/tools/<name>` and `GET /medical/memory[/<id>]`;
- the CLI (`npm run medical -- memory ms2`, `… tool begin_medical_check '{…}'`);
- or the JSON Schemas directly.

---

## 2. Persistent memory (`medical/memory/store.mjs`)

**Storage.**

- One file per astronaut: `memory/crew/<crew-id>.json` (or
  `$MEBO_MEMORY_DIR`).
- Plain JSON, gitignored, written atomically (temporary file, then rename).
- The format is in [memory/README.md](../memory/README.md).

**Contents.**

- `symptoms`: what was reported.
- `conversations`: one-line notes MeBo writes at the end of a check.
- `assessments`: each linked by `assessment_id`, with level, status, rule
  ids, the dataset checksum and the inputs hash. The full record can always
  be regenerated from SQLite.
- `answers`: per workflow.
- `concerns`: open and resolved.

Times are wall-clock ISO timestamps; each assessment also records the
scenario time it was evaluated at.

**Isolation, enforced in code and tested.**

- A file can only be named by a crew id that exists in the medical database,
  so forged ids and path traversal are rejected.
- Every file records its owner, and a file whose owner field names someone
  else is refused rather than read.
- An assessment can only be filed under the astronaut it was run for.
- Summaries, answers and follow-ups are always read from one file. The tests
  check that, after a full check for Novak, Reyes's memory is empty and
  Novak's file mentions no other crew member.

**SQLite stays authoritative.** Memory stores no readings. Recent history in
a check is read live from SQLite each time.

### Answer reuse: no repeated questions

An answer is reused only within its question's validity window. Answers
given in the current conversation always override remembered ones, and a
reused answer keeps its original time, so a window is never stretched. The
result lists every reused answer and its age in `answers_from_memory`.

| Question | Window | Why (prototype assumption) |
|---|---|---|
| chest_pain, short_of_breath, weak_or_lightheaded, radiating_pain | 30 min | "right now" — one conversation |
| fainted, palpitations | 6 h | "since your last check" |
| fatigue | 2 h | "right now", but tiredness changes slowly |
| dozed_on_task | 12 h | a recent event |
| schedule_shift | 24 h | "in the last week" |
| self_harm | **never reused** | a safety question is always asked fresh |

`use_remembered_answers: false` asks everything again.

### Concerns and proactive follow-up

- **Opened by the rules.** A finding at level `review`, `urgent` or
  `emergency` opens a concern. An incomplete assessment opens a "not
  finished" concern.
- **Closed by the rules.** Only a later *complete* assessment of the same
  workflow, in which that rule evaluated `false`, closes it. Missing data
  (`null`) never closes a concern.
- **Not closable by talk.** There is no resolve, delete or clear tool, and
  `record_crew_memory` accepts only `symptom` or `conversation_note`.
- **Follow-up prompts.** Open concerns produce predefined prompts, for
  example: "Last cardiovascular change assessment on 2026-11-15 found:
  Weakness or light-headedness (urgent). Ask how they are now, and offer to
  repeat the assessment." `get_crew_memory` and `begin_medical_check` return
  them, and MeBo is told to raise the first one gently.

**Memory never changes an escalation.** The rules read only `data.*` and
`answers.*`. Memory supplies nothing but answers the astronaut actually gave,
inside their windows. A test files an open urgent concern, then reassesses
with normal answers: the result's level, evidence and `assessment_id` are
identical to running the rules without memory at all.

---

## 3. The two workflows (`medical/workflows.mjs`)

Both follow the same shape:

1. **Identify.** `identify_crew_member` matches a callsign, surname or
   spoken role ("the pilot", "commander"). Ambiguous ("mission specialist" —
   there are two) or unknown names return `found: false` with candidates, and
   MeBo asks.
2. **Recall.** `get_crew_memory`, and raise any follow-up.
3. **Begin.** `begin_medical_check` with the reported symptom:
   - It routes to a workflow by fixed keywords, so routing does not depend
     on which model heard the complaint. Ambiguous ("dizzy and exhausted") or
     unrelated ("my knee hurts") complaints get no workflow, and MeBo asks.
   - It records the symptom.
   - It returns recent history from SQLite, relevant memory and follow-ups,
     `questions_to_ask` with `already_answered` removed, NASA guidance
     passages, and the next step.
4. **Ask.** Only `questions_to_ask`, one at a time, in their exact wording.
5. **Assess.** `assess_cardiovascular` or `assess_sleep_fatigue` merges
   remembered answers, runs the rules, and files the result in memory.
6. **Explain.** Escalation guidance first, then the main concern, then the
   next step, all from the result.
7. **Note.** `record_crew_memory` with a one-line `conversation_note`.

**Cardiovascular.** The trigger is dizziness, a racing or pounding heart,
palpitations or chest discomfort:

- **History:** heart rate and blood pressure from SQLite, with latest
  reading, baseline, 7-day mean and 14-day slope.
- **Questions:** the six cardiovascular questions.
- **Findings:** from the Step 20 rules, for example light-headedness gives
  `urgent` (CV-S4) and opens a concern.

**Sleep and fatigue.** The trigger is poor sleep, exhaustion or tiredness:

- **History:** sleep and mood from SQLite.
- **Questions:** the fatigue and sleep questions. The self-harm question is
  added only when the data show low mood (Novak), and is never reused.
- **Guidance:** NASA's own words, the Risk of Inadequate Sleep and Irregular
  Schedules and ARCHeR passages, cited, as background that does not affect
  the rules.

The routing keywords are in `ROUTES`. They are English only, a prototype
assumption, and checked by tests.

---

## 4. Medical Agents panel

The panel shows real activity, with its design and animations unchanged:

- **The bridge reports each call.** The MCP adapter reports every medical
  tool call as a `medical` WebSocket frame, at start and at end. The end
  frame carries the workflow, level, status, assessment id and callsign from
  the tool's own result.
- **Row states** for Cardiovascular Check and Sleep & Fatigue Check:

  | State | Shows | LED |
  |---|---|---|
  | `running` | "Assessing NOVAK…" while the tool runs | existing `agent-busy` pulse |
  | `checking` | "NOVAK · asking questions" between begin and assess (15-minute timeout) | existing `agent-busy` pulse |
  | `done` | "NOVAK · MONITOR · 2 min ago" | `led-warn` (amber) at review or above; otherwise `led-on` |
  | `idle` | the original description | `led-on` |

- **Read back on load.** On page load the last outcome per workflow is read
  from `GET /medical/memory`, so it survives a reload.

A browser test shows "Rule-based · HR, BP, symptoms" before a check,
"NOVAK · MONITOR · just now" after a real ask through the bridge, and the
same outcome after a fresh page load.

---

## 5. Tools and permissions

| Tool | Reads | Writes |
|---|---|---|
| `list_crew`, `identify_crew_member`, `get_crew_health_summary` | SQLite | — |
| `get_crew_memory` | memory | — |
| `begin_medical_check` | SQLite, memory, NASA library | the reported symptom (memory) |
| `get_self_assessment_questions` | question set, memory | — |
| `assess_cardiovascular`, `assess_sleep_fatigue` | SQLite, memory answers | the result, answers given, concerns (memory) |
| `record_crew_memory` | — | one note, at most 500 characters, symptom or conversation note (memory) |
| `search_space_medical_knowledge` | NASA library | — |
| `get_visual_observations` | Camera observations in memory (Step 26) | — |
| `get_alertness_summary` | Camera alertness measures beside sleep history, self-report and the last sleep and fatigue assessment (Step 26B); sets no level | — |
| `request_visual_observation` (bridge only) | Runs the guided camera check in the page | Memory, `observations`: numeric summary only, filed by the page (see [camera-assessment.md](camera-assessment.md)) |

**What no tool can do:**

- write to the medical database;
- delete or resolve anything in memory;
- accept a threshold, rule or level from the caller.

**How the policy treats them.** The `mebo_medical` server is admitted by the
existing policy as MeBo's own surface, alongside its display and interface
tools. The only writes are to MeBo's own local memory files. Unknown
arguments and over-long notes are rejected.

---

## 6. Validation

`test/memory-workflows.test.mjs` (12 tests) covers:

- continuity across a service restart **and across a real bridge restart**;
- isolation: per-file, forged ids, mismatched assessments, tampered owner
  fields;
- missing information: identification, ambiguous routing, incomplete
  assessments and their follow-up;
- repeat assessments: windows, overrides, original timestamps, opt-out,
  appended history;
- both full workflows: concerning and normal paths, and follow-up the next
  day;
- that memory never changes an escalation;
- offline operation;
- the HTTP surface and the panel activity.

`test/medical-agent.test.mjs` additionally drives the real bridge with a
scripted CLI. It checks that the assessment is filed in Novak's memory and
that the panel's activity frames reach the browser with the real outcome.

Existing tests use private memory directories, and running the suite leaves
`memory/crew/` untouched.

---

## 7. Limitations

- **Model behaviour is prompted, not enforced.** The model's conversational
  behaviour (proactively starting a check, asking only the listed questions,
  raising follow-ups) is driven by the persona prompt. It has been exercised
  with a scripted stand-in and in typed live runs on both providers
  ([llm-providers.md](llm-providers.md)); a real spoken run is still needed.
- **Identification is by name, not authentication.** Anyone can say "this
  is Novak". On a real crew this would need an authenticated identity.
- **Conversation notes are written by the model.** They can be imprecise.
  They are labelled `source: mebo` and never feed a rule.
- **Prototype windows and routing.** The answer-reuse windows are
  assumptions, and routing uses English keywords.
- **Concerns can stay open.** A concern whose rule can never re-evaluate (its
  data stays missing) stays open until a complete reassessment.
- **Unprotected local files.** There is no encryption, no file locking
  across several bridge processes, and no "forget me" tool. Deleting the
  file is the only erasure. Retention is capped at 200 entries per list.
- **Two clocks.** Memory uses wall-clock time, while the synthetic data use
  scenario time (day 120 of the transit).
