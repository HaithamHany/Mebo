# MeBo conversational memory

`memory/crew/<crew-id>.json` holds one file per astronaut. It is created on
first use and gitignored, because it is a personal history. Point it
elsewhere with `MEBO_MEMORY_DIR`.

**This is continuity, not the medical record.** Measurements live only in
the SQLite database (`data/medical/`). A memory file holds:

| Field | Contents |
|---|---|
| `astronaut_id` | The owner, checked on every read and write |
| `symptoms` | What the astronaut reported, as MeBo understood it (`source: crew_report`) |
| `conversations` | One-line notes MeBo wrote at the end of a conversation (`source: mebo`) |
| `assessments` | Each assessment MeBo ran, linked by `assessment_id`, with level, status, rule ids, the dataset checksum and the inputs hash |
| `answers` | The last answer to each self-assessment question, per workflow, reused only within that question's validity window |
| `concerns` | Open and resolved concerns. A finding at review or above opens one. Only a later complete assessment in which that rule evaluates false resolves it |
| `observations` | Summaries of guided camera checks: counts, ranges and which instructed tasks were completed. Numbers only, with no image, video or landmarks. Supplementary: they never open a concern or feed an assessment |

Memory never changes an assessment. See
[docs/agent-workflows.md](../docs/agent-workflows.md) and
[docs/camera-assessment.md](../docs/camera-assessment.md).
