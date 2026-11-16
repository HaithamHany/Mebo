import { useEffect, useRef } from 'react'
import { Scene } from './scene/Scene'
import { Hud } from './ui/Hud'
import { Boot } from './ui/Boot'
import { Ignition } from './ui/Ignition'
import { configureHealthCheck, requestHealthCheck } from './lib/healthcheck'
import { Diagnostics } from './ui/Diagnostics'
import { useStore } from './store'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import {
  createSpeaker,
  cycleVoice,
  currentVoiceName,
  getEngine,
  setEngine,
  ENGINES,
  diag as ttsDiag,
  speakingSince,
  speechLevel,
} from './lib/tts'
import * as piper from './lib/piper'
import { useMedical, type MedicalActivity } from './ui/medical/telemetry'
import {
  cancelVisualCheck,
  collapseVisual,
  configureVisual,
  observationWindow,
  runVisualCheck,
  setObservationWindow,
  visualRunning,
} from './lib/visual/assessment'
import {
  cancelFollowUp,
  configureFollowUp,
  deliverAnswer,
  followUpActive,
  followUpAwaiting,
} from './lib/visual/followup'
import * as sfx from './lib/sfx'
import * as music from './lib/music'
import * as hands from './lib/hands'
import { listenForClap } from './lib/clap'
import * as camera from './lib/camera'
import * as kokoro from './lib/kokoro'
import { TTS_ENGINE } from './config'
import { forTool, attention, fixedLines } from './lib/fillers'
import {
  ask,
  warm,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchMedical,
  watchVisual,
  watchConnection,
  connectedLabels,
  usingBridge,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { bridgeStatus, probeCapabilities } from './lib/capabilities'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 11000

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke it as "mibo" gets that word sent on to the model as a question. */
const NAME = '(?:me[\\s-]?bo|mee[\\s-]?bo|mibo|mebow|meabo|bay[\\s-]?max|beymax|baymacks)'
/** A bare vocative — "MeBo", "hey MeBo" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "MeBo, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

/** Baymax's deactivation phrase: "I am satisfied with my care." */
const SATISFIED = /\bsatisfied with (?:my |the |your |this )?care\b/i

/** Spoken once per activation, the way Baymax greets a patient. */
const INTRODUCTION = 'Hello. I am MeBo, your personal healthcare companion.'
const FAREWELL = 'I am glad I could help. Goodbye.'

export default function App() {
  const store = useStore
  const phase = useStore((s) => s.phase)
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  const listen = (window: number) => {
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  const respond = async (said: string): Promise<void> => {
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')

    const spk = createSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'mebo', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          // The camera check opens with its own spoken explanation, so a
          // filler would talk over it.
          if (!filled && !started && !name.endsWith('request_visual_observation')) {
            filled = true
            spk.say(forTool(name))
          }
        },
      })

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        listen(FOLLOW_UP_MS)
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    // The camera check's interview is waiting for an answer: listen for it,
    // whatever the phase (it may run in standby, or mid-turn when MeBo asked).
    if (followUpAwaiting()) return 'command'
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string, distress = false) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // Woken by a cry of pain rather than by name, the way Baymax activates.
    // The words go to the model as heard ("Ow, my wrist"), and the persona
    // answers with the introduction and the pain scale.
    if (distress) {
      void respond(trailing || 'Ow.')
      return
    }

    // "MeBo, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    // Talking to the camera check or its questions is not an interruption of
    // the conversation — when MeBo started the check, its turn is waiting on it.
    if (visualRunning() || followUpActive()) return
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    // An answer to the camera check's questions goes there, not to the model.
    if (deliverAnswer(text)) return
    // During the camera check itself, speech is not a question either; "stop" ends it.
    if (visualRunning()) {
      if (/\b(stop|cancel)\b/i.test(text)) cancelVisualCheck()
      return
    }
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending the name to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    // Baymax's rule: he deactivates when the patient says they are satisfied
    // with their care, and not before. Handled here rather than by the model
    // because it is a state change, and it has to work every time.
    if (SATISFIED.test(said)) {
      void deactivate(said)
      return
    }

    void respond(said)
  }

  /** "I am satisfied with my care" — a short goodbye, then standby. */
  const deactivate = async (said: string) => {
    const mine = ++turn.current
    clearIdle()
    silence()
    const s = store.getState()
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.pushTurn({ id: newId(), role: 'mebo', text: FAREWELL })
    s.setPhase('speaking')
    const bye = createSpeaker()
    speaker.current = bye
    bye.say(FAREWELL)
    await bye.end()
    if (mine !== turn.current) return
    sfx.play('done')
    goDormant()
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  const powerOn = async () => {
    // The ignition button and the space bar can both land here, and the phase
    // only moves after the first await — so without this a double press boots
    // twice, arming two voice loops and two download polls.
    if (booting.current) return
    booting.current = true

    try {
      await ignite()
    } catch (err) {
      // The guard must not outlive a failed boot. Audio unlock can be refused,
      // the microphone prompt dismissed, the bridge unreachable at the wrong
      // moment — and with the flag still latched the ignition button was dead
      // for the rest of the page, recoverable only by reloading. Reset it and
      // put the button back so the user can simply press it again.
      booting.current = false
      console.error('[mebo] power-up failed:', err)
      store.getState().setPhase('offline')
      store
        .getState()
        .setError(
          err instanceof Error
            ? `Power-up failed: ${err.message}`
            : 'Power-up failed. Click to try again.',
        )
    }
  }

  const ignite = async () => {
    const s = store.getState()

    // Must happen inside the click handler — browsers won't start an
    // AudioContext or speech synthesis without a user gesture.
    await sfx.unlockAudio()
    sfx.play('boot')
    // The work cue's audio. Must be enabled from inside this click handler for
    // the same reason as the rest of the audio. There is no intro music any
    // more: the MeBo start-up score is gone, and MeBo's activation is the
    // soft `boot` chime above followed by its spoken introduction.
    music.enable()

    s.setPhase('boot')

    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    /**
     * MeBo asking to see something.
     *
     * Announced on screen for as long as it takes, with whatever he said he was
     * looking for. The camera's own light is on too, but a hardware light that
     * appears with no explanation is exactly the thing that makes people
     * distrust an assistant — so the interface says it before they have to ask.
     */
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'reviewing the last few seconds'
            : `${req.reason || 'watching'} · ${req.seconds}s`
          : req.reason || 'taking a look'
      store.getState().setLooking(note)

      // The past is only available if something has been remembering it, and
      // that only happens while the camera is on screen. Answering plainly
      // beats opening the camera and recording the next few seconds instead,
      // which is a different question from the one that was asked.
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return {
          error:
            'There is no recent footage — the camera has to be open on screen ' +
            'for me to remember what just happened. Ask me to open the camera, ' +
            'and I can watch from then on.',
        }
      }

      // Held for the whole capture. Without this the stream can be torn down by
      // whoever else was using it half way through a six-second watch.
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    // The guided camera check (Step 26) speaks in MeBo's voice, and runs when
    // MeBo asks for it (request_visual_observation) or from its panel. Only
    // the numeric summary ever goes back — never a frame.
    // Sentence by sentence, the way answers are spoken (push, not say).
    // The closing announcement is about 45 s of speech: sent to Piper as
    // one block it took over 20 s to generate, hit Piper's timeout, and
    // was spoken in the system voice instead — MeBo's voice changed after
    // every camera check, after a long silence.
    const sayInVoice = async (text: string) => {
      const s = createSpeaker()
      s.push(text)
      await s.end()
    }
    configureVisual({ say: sayInVoice })
    // The sleep and fatigue questions after a camera check (Step 26C).
    configureFollowUp({ say: sayInVoice })
    configureHealthCheck({ say: sayInVoice })
    watchVisual(async (req) => {
      // MeBo asked, so MeBo's own reply explains the camera result; the page
      // still runs the sleep and fatigue questions and returns the rules
      // engine's assessment with it.
      const r = await runVisualCheck(req.crew_id, { explain: false })
      if (!r.ok) return { error: r.error, ...(r.sleep_fatigue ? { sleep_fatigue: r.sleep_fatigue } : {}) }
      return {
        recorded: r.recorded,
        observation: r.observation,
        saved: r.saved,
        description: r.recorded?.description ?? null,
        explanation: r.recorded?.explanation ?? null,
        follow_up: r.recorded?.follow_up ?? [],
        sleep_fatigue: r.sleep_fatigue ?? null,
        ...(r.error ? { warning: r.error } : {}),
      }
    })

    // The interface is MeBo's to drive. These arrive out of band, pushed
    // mid-turn the way panels are, so a command can retint the reactor or put
    // something into orbit while he is still speaking the sentence about it.
    // Medical tool activity (Step 23): drives the Medical Agents panel.
    watchMedical((activity) => useMedical.getState().noteActivity(activity as unknown as MedicalActivity))

    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, never>
      switch (op) {
        case 'patch':
          s.applyUi(args)
          break
        case 'orbit':
          if (a.action === 'add') s.addOrbit(args)
          else if (a.action === 'remove') s.removeOrbit(String(a.id))
          else s.clearOrbits()
          break
        case 'effect':
          s.fireEffect(a.kind)
          break
        case 'reset':
          s.resetUi()
          break
        case 'screen':
          s.clearScreen(a.what ?? 'all')
          break
        default:
          console.warn('[mebo] unknown ui op:', op, args)
      }
    })
    // In bridge mode the conversation lives in the agent session, which is tied
    // to the socket — so a drop silently wipes his memory while the transcript
    // on screen still shows it. Better to say so than to let him quietly forget.
    watchConnection((state) => {
      if (state === 'lost') {
        store.getState().setError('Bridge connection lost — reconnecting.')
      } else if (state === 'reconnected') {
        store
          .getState()
          .setError('Bridge reconnected. The previous conversation was not kept.')
      }
    })
    const warming = warm().catch((err: Error) => s.setError(err.message))


    // Pull the neural voice down during the boot sequence so the first
    // "Hey MeBo" isn't waiting on a model load. Deliberately not awaited — if
    // it's slow, MeBo comes up on the system voice and swaps over the moment
    // the model is ready. Piper is MeBo's own voice; Kokoro is only fetched if
    // Piper cannot run, since it is the fallback.
    if (TTS_ENGINE !== 'system') {
      if (TTS_ENGINE === 'piper') {
        void piper.load().then((ok) => {
          if (!ok) void kokoro.load()
          store.getState().setVoice(currentVoiceName())
          // Generated during the boot sequence, so the introduction and the
          // answer to "Hey MeBo" play at once rather than after synthesis.
          if (ok) piper.prewarm([INTRODUCTION, ...fixedLines(), FAREWELL])
        })
      } else {
        void kokoro.load()
      }
      voicePoll.current = setInterval(() => {
        const eng = TTS_ENGINE === 'piper' && !piper.isUnavailable() ? piper : kokoro
        const p = eng.loadProgress()
        if (eng.isReady() || kokoro.isUnavailable()) {
          store.getState().setBootNote('')
          if (voicePoll.current) clearInterval(voicePoll.current)
          voicePoll.current = null
        } else if (p > 0 && p < 1) {
          store.getState().setBootNote(`voice ${Math.round(p * 100)}%`)
        }
      }, 200)
    }

    // Long enough for the four-beat start-up sequence in Boot.tsx to play —
    // status bar, rings, body scan, MeBo's face opening — before the live
    // interface takes over and MeBo introduces itself.
    await new Promise((r) => setTimeout(r, 9200)) // boot sequence
    await warming
    store.getState().setConnected(connectedLabels())

    // The analyser is what makes the reactor pulse with your voice. It needs a
    // getUserMedia stream; speech recognition does not, and gets its own. So a
    // failure here costs the animation and nothing else — saying "voice input
    // is unavailable" was both alarming and untrue.
    try {
      await startAnalyser()
    } catch {
      console.warn(
        '[mebo] no microphone stream — the reactor will not pulse with your ' +
          'voice. Speech recognition is unaffected.',
      )
    }

    // Ask the bridge which speech engines exist before the loop starts, so the
    // first turn already uses ElevenLabs when a key is present and the browser
    // fallback when it is not — no flag, no reload. The HUD label is set only
    // after this resolves, or it always reports the browser fallback voice
    // even when ElevenLabs is the one actually about to speak.
    await probeCapabilities()
    store.getState().setVoice(currentVoiceName())
    // A bridge older than this page has none of the medical tools, and MeBo
    // would honestly answer that it has no records. Say why, once, instead.
    if (bridgeStatus()?.outdated) {
      store
        .getState()
        .setError("MeBo's bridge is running older code than this page — restart it (npm start) to load the medical tools.")
    }

    // One voice loop, started once, running until the page closes.
    voice.current = await startVoice({
      mode,
      onWake,
      onSpeechStart,
      onPartial,
      onUtterance,
      onError: onVoiceError,
    })

    store.getState().setPhase('dormant')
    void introduce()
  }

  /**
   * Baymax greets the patient the moment he is activated. Spoken in the
   * 'waking' phase, like the greeting on his name: the microphone is open and
   * talking over it simply silences it, without cancelling a model turn that
   * does not exist. Afterwards the mic stays open for a reply.
   */
  const introduce = async () => {
    const s = store.getState()
    s.pushTurn({ id: newId(), role: 'mebo', text: INTRODUCTION })
    s.setPhase('waking')
    const hello = createSpeaker()
    speaker.current = hello
    hello.say(INTRODUCTION)
    await hello.end()
    // Interrupted (silence() cleared it) or superseded by a wake or a turn.
    if (speaker.current !== hello || store.getState().phase !== 'waking') return
    speaker.current = null
    listen(AWAIT_SPEECH_MS)
  }

  // -- clap to start --------------------------------------------------------

  /**
   * A clap brings him up, as an alternative to the button.
   *
   * Only while the ignition screen is showing, and torn down the moment he
   * boots — the microphone is about to belong to the voice loop, and two
   * analysers arguing over the same stream is how you get an assistant that
   * hears half of what you say.
   *
   * Deliberately silent about failure. If the microphone is refused, or has not
   * been granted yet, the button is still right there; announcing an error
   * about a feature nobody asked for would be worse than quietly doing without.
   */
  useEffect(() => {
    if (phase !== 'offline') return
    let live: { stop: () => void } | null = null
    let gone = false
    void listenForClap(() => {
      if (!gone) void powerOn()
    }).then((l) => {
      if (gone) l.stop()
      else live = l
    })
    return () => {
      gone = true
      live?.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0

    const pump = () => {
      const st = store.getState()
      // While speaking, follow MeBo's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise. 'waking' too: that is
      // when the introduction and the greeting on its name are spoken.
      // Any audible speech counts, including the camera check's and the
      // health check's, which have speakers of their own.
      const lvl = speakingSince()
        ? speechLevel()
        : (st.phase === 'speaking' || st.phase === 'waking') && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Voice set to ${name.replace(/\(.*?\)/g, '').trim()}. I am MeBo, your medical companion.`)
        void demo.end()
        return
      }

      // G puts the camera on and starts tracking hands. Off by default and
      // never implicit: a webcam that turns itself on because an interface
      // thought it might be useful is not a trade anyone agreed to.
      if (e.key === 'g' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const on = store.getState().gestures
        if (on) {
          hands.disableHands()
          store.getState().setGestures(false)
        } else {
          store.getState().setError(null)
          void hands
            .enableHands()
            .then(() => store.getState().setGestures(true))
            .catch((err: Error) => {
              store.getState().setGestures(false)
              store
                .getState()
                .setError(
                  err?.name === 'NotAllowedError'
                    ? 'Camera access denied — gesture control is unavailable.'
                    : `Gesture control failed to start: ${err?.message ?? err}`,
                )
            })
        }
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Audio test. If you can hear this, speech output is working.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[mebo] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        // A camera check in progress stops too, and its camera hold is released;
        // a finished one folds back into its side card.
        cancelVisualCheck()
        cancelFollowUp()
        collapseVisual()
        if (store.getState().phase !== 'offline') goDormant()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      const phase = store.getState().phase
      if (phase === 'offline') {
        void powerOn()
      } else if (phase === 'boot') {
        /* ignore — the boot sequence owns the phase until it finishes */
      } else if (
        phase === 'thinking' ||
        phase === 'tooling' ||
        phase === 'speaking'
      ) {
        onSpeechStart()
        listen(AWAIT_SPEECH_MS)
      } else {
        onWake('')
      }
    }
    window.addEventListener('keydown', onKey)

    // Voice tuning from the console, e.g.
    //   __mebo.voice.setRate(0.85); __mebo.voice.say('Hello. I am MeBo.')
    //   __mebo.voice.setEngine('kokoro'); __mebo.voice.status()
    // The rate is Piper's and is remembered in this browser.
    const say = (text = 'Hello. I am MeBo, your medical companion. How are you feeling today?') => {
      silence()
      const s = createSpeaker()
      speaker.current = s
      s.say(text)
      return s.end()
    }
    ;(window as unknown as Record<string, unknown>).__mebo = {
      // The camera check's natural-observation window, seconds (20 to 180).
      visual: { window: observationWindow, setWindow: setObservationWindow },
      voice: {
        engines: ENGINES,
        engine: getEngine,
        setEngine: (e: (typeof ENGINES)[number]) => {
          const now = setEngine(e)
          store.getState().setVoice(currentVoiceName())
          return now
        },
        rate: piper.getRate,
        setRate: piper.setRate,
        resetRate: piper.resetRate,
        say,
        status: () => ({
          engine: getEngine(),
          speaking: ttsDiag.engine,
          voice: currentVoiceName(),
          rate: piper.getRate(),
          piper: {
            ready: piper.isReady(),
            unavailable: piper.isUnavailable(),
            error: piper.lastError,
            ...piper.stats,
          },
          kokoro: { ready: kokoro.isReady(), unavailable: kokoro.isUnavailable(), error: kokoro.lastError },
        }),
      },
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
      // The camera must not outlive the page that turned it on.
      hands.disableHands()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <Scene />
      <Hud />
      <Boot />
      <Diagnostics />
      <Ignition
        onStart={(intent) => {
          if (intent === 'check') requestHealthCheck()
          void powerOn()
        }}
      />
    </>
  )
}
