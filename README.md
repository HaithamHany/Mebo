# MeBo (Medical Bot) — Astronaut Medical Companion

*NASA Space Apps Challenge 2026 — prototype with simulated crew data.*

MeBo is a calm, voice-first medical companion for crews on long-duration
missions. It runs guided health checks, explains how spaceflight affects the
body from official NASA and CSA sources, and remembers each crew member's
history — all on the crew's own computer, with an offline mode that needs no
internet at all.

**MeBo does not diagnose anything.** Every clinical level and recommendation
comes from a deterministic, documented rules engine. The language model only
talks and calls tools; it never decides. All crew data is synthetic: four
fictional astronauts on a fictional Mars transit.

## What it does

- **Guided health check.** Choose a crew member and MeBo walks them through it:
  1. a review of their records against their personal baseline;
  2. the structured sleep and fatigue questions, by voice or on screen;
  3. an optional camera check;
  4. the results, spoken and shown.
- **Rules-based assessments.** There are two:
  - **Cardiovascular:** heart rate, blood pressure, SpO₂ and symptoms.
  - **Sleep and fatigue:** sleep against the personal baseline, self-rated
    fatigue, dozing on task, schedule shifts and mood.

  Each rule carries its source and evidence level. See
  [docs/clinical-decision-support.md](docs/clinical-decision-support.md).
- **Camera-supported alertness.** MediaPipe Face Landmarker runs in the
  browser from local files. It measures the eye aspect ratio, PERCLOS and
  long eye closures, and grades the quality of each measurement. These camera
  measures can only add to a separate, clearly labelled fatigue concern. They
  never lower the clinical level, and no image or video is stored or sent. See:
  - [docs/camera-assessment.md](docs/camera-assessment.md);
  - [docs/alertness-assessment.md](docs/alertness-assessment.md);
  - [docs/fatigue-concern.md](docs/fatigue-concern.md).
- **NASA knowledge.** An offline library holds five NASA and CSA pages,
  stored verbatim with citations
  ([docs/nasa-resource-traceability.md](docs/nasa-resource-traceability.md)).
- **Crew memory.** One local JSON file per astronaut holds their reported
  symptoms, past assessments and the concerns still open. Memory never changes
  a clinical decision ([docs/agent-workflows.md](docs/agent-workflows.md)).
- **Voice.** Piper `en_US-lessac-medium` runs in the browser, so speech never
  leaves the machine. The wake word is "MeBo", and you can talk over it to
  interrupt.

## Two ways to run the model

| Mode | `LLM_PROVIDER` | Model | Needs |
|---|---|---|---|
| Offline | `ollama` | `gemma4:e4b` | [Ollama](https://ollama.com) and `ollama pull gemma4:e4b` |
| Online | `huggingface` | `google/gemma-4-26B-A4B-it` | `HF_TOKEN` (Hugging Face Inference Providers) |

The model runs behind the local bridge (`bridge/`), which offers it MeBo's 13
medical tools plus the guided camera check. Every credential stays in the
bridge process; the browser never holds one. Design details and measurements
are in [docs/llm-providers.md](docs/llm-providers.md).

## Quick start

Requirements:
- Node.js 22.13 or newer (for the built-in `node:sqlite`);
- Chrome or Edge (for speech recognition);
- for offline mode, Ollama with `gemma4:e4b`. An NVIDIA GPU makes it much
  faster.

```bash
npm install
cp .env.example .env      # then set LLM_PROVIDER, and HF_TOKEN for online mode
npm run setup             # advisory check: Node, Ollama, token present (never printed)
npm start                 # bridge + app; open the URL it prints
```

The first `npm start` downloads two models into the git-ignored `public/models/`:
- the Piper voice (about 63 MB);
- the MediaPipe face model.

On the opening screen, choose **Start Health Check**, or **Explore Crew
Health** for the dashboard.

Useful commands:

- `npm test`: all tests. The model is replaced by a scripted stand-in, so
  no network or account is needed.
- `npm run medical -- summary ms2`: query the medical data from the command
  line.
- `npm run medical:serve`: the medical API on its own.
- `npm run medical:seed -- --force`: regenerate the synthetic dataset.
- `npm run knowledge:fetch`: refresh the NASA and CSA library.

### Settings

All settings are listed in [`.env.example`](.env.example).
- **Bridge settings:** `LLM_PROVIDER`, `HF_TOKEN`, `OLLAMA_*` and
  `MEBO_BRIDGE_*`. The bridge reads them from its environment or from the
  git-ignored `.env`.
- **Browser settings:** only the `VITE_*` voice settings reach the browser.
  Never put a secret in a `VITE_` variable.

Older `JARVIS_*` setting names are still read by the bridge as fallbacks.

### Voice tuning

- **Speaking rate:** `VITE_PIPER_RATE`, default `0.85`. To tune it live, run
  `__mebo.voice.setRate(0.8)` then `__mebo.voice.say()` in the browser
  console.
- **Engine:** `VITE_TTS_ENGINE=piper|kokoro|system`. Switch live with
  `__mebo.voice.setEngine('kokoro')`.
- **Fallback:** if Piper can't load, MeBo uses Kokoro, then the system voice.

## Security

- **Bridge network access:**
  - it listens on `127.0.0.1` only;
  - it answers only requests addressed to `localhost`, which blocks DNS
    rebinding;
  - its WebSocket accepts only local development origins.
- **Credentials:** they stay in the bridge. `/health` reports the provider and
  model name, never a token. `.env`, crew memory (`memory/crew/`), the SQLite
  database (`data/`) and downloaded models are all git-ignored.
- **Fetch proxies:** `/img`, `/media` and `/page` refuse private, loopback and
  cloud-metadata addresses. `/file` serves only images from MeBo's own
  workspace and temp folders.
- **Medical tools:** they validate every argument against a fixed schema, and
  take no thresholds or measurements from the model.
- **Cost guard:** model calls are capped per hour (`LLM_MAX_CALLS_PER_HOUR`,
  default 300) to bound paid inference.
- **Browser:** a strict Content Security Policy is set in `index.html`, and
  any HTML panel content is sanitised with DOMPurify.
- **Hosting.** Locally the bridge listens on this machine only. To host MeBo,
  use the Netlify setup ([docs/deploy-netlify.md](docs/deploy-netlify.md)).
  It runs the bridge in public mode, with a private, durable crew memory per
  visitor and per-visitor limits. The bridge has no user accounts, so also turn
  on Netlify's password protection or team login.

## Credits and licence

MeBo is released under the MIT License (see [LICENSE](LICENSE)).

**MeBo is built on J.A.R.V.I.S., the open-source browser voice assistant by
Aditya Dewaskar** (MIT License, copyright © 2026 Aditya Dewaskar), whose
copyright and permission notice are kept in [LICENSE](LICENSE). It provided
the voice pipeline, the interface, the bridge architecture and its security
model, which MeBo adapted into a medical companion.

Third-party work:

- **Music:** "Mechanolith" by Kevin MacLeod (incompetech.com), licensed CC BY
  4.0. See [public/audio/CREDITS.md](public/audio/CREDITS.md).
- **Voice:** the Piper `en_US-lessac-medium` voice (rhasspy/piper), and
  Kokoro via `kokoro-js`.
- **Face tracking:** MediaPipe Face Landmarker (Google, Apache 2.0).
- **Knowledge:**
  - NASA Human Research Program and Canadian Space Agency public pages,
    quoted with citations;
  - the peer-reviewed references listed in each document under `docs/`.
- **Language models:** Gemma 4 by Google, served through Ollama or Hugging
  Face Inference Providers, under the Gemma terms of use.
