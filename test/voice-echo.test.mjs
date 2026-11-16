/**
 * The echo filter (src/lib/echo.ts): the microphone stays open while MeBo
 * talks, and these rules decide from the words alone whether a transcript is
 * MeBo hearing itself or the crew member speaking.
 *
 * The regression this guards: MeBo asks questions, and the natural answer
 * repeats the question's words — "I have chest pain" after "Do you have any
 * chest pain…?". Judged by word overlap alone, 20 of 31 such replies were
 * thrown away as echo, so the microphone seemed deaf exactly when MeBo had
 * asked something. Real echoes must still be caught.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEcho, overrides } from '../src/lib/echo.ts'

// MeBo's own questions: the self-assessment wording (medical/cds/questions.mjs)
// and the persona's pain scale and deactivation question.
const CHEST = 'Do you have any chest pain, pressure or discomfort right now?'
const BREATH = 'Are you short of breath right now, while resting?'
const WEAK = 'Do you feel weak, light-headed or faint?'
const HEART = 'Have you noticed a racing, pounding or irregular heartbeat?'
const DOZED = 'Have you fallen asleep, or nearly fallen asleep, during a task?'
const SCHEDULE = 'Has your sleep or work schedule shifted in the last week?'
const SATISFIED = 'Are you satisfied with your care?'
const INTRO = 'Hello. I am MeBo, your personal healthcare companion.'

test('answers that repeat the question are the person talking, not echo', () => {
  const replies = [
    [CHEST, 'yes chest pain'],
    [CHEST, 'I have chest pain'],
    [CHEST, "I've got some chest pressure"],
    [BREATH, 'yes short of breath'],
    [BREATH, 'I am short of breath'],
    [WEAK, 'yes light-headed'],
    [WEAK, 'I feel weak'],
    [WEAK, 'I feel a bit faint'],
    [HEART, 'yes racing heartbeat'],
    [HEART, 'my heartbeat is racing'],
    [HEART, 'irregular heartbeat yeah'],
    [DOZED, 'I nearly fell asleep during a task'],
    [SCHEDULE, 'yes my schedule shifted'],
    [SCHEDULE, 'my sleep schedule shifted last week'],
    [SCHEDULE, 'not my work schedule'],
    [SATISFIED, 'I am satisfied with my care'],
    [SATISFIED, "I'm satisfied with my care"],
  ]
  for (const [question, reply] of replies) {
    assert.equal(isEcho(reply, question), false, `"${reply}" after "${question}" was dropped as echo`)
  }
})

test('MeBo hearing its own words is still echo', () => {
  for (const question of [CHEST, BREATH, WEAK, HEART, DOZED, SCHEDULE, SATISFIED]) {
    const words = question.replace(/[?,.]/g, '').split(' ')
    for (const fragment of [words.join(' '), words.slice(0, 4).join(' '), words.slice(-4).join(' ')]) {
      assert.equal(isEcho(fragment, question), true, `echo "${fragment}" of "${question}" got through`)
    }
  }
})

test('an answering word MeBo said itself is not evidence of the person', () => {
  // MeBo speaks in the first person sometimes; its own "I am" comes back too,
  // often contracted by the recogniser.
  assert.equal(isEcho('hello I am MeBo your personal healthcare companion', INTRO), true)
  assert.equal(isEcho("hello I'm MeBo your personal healthcare companion", INTRO), true)
  assert.equal(isEcho('yes I am here', 'Yes. I am here.'), true)
  assert.equal(isEcho('I am looking', 'I am looking.'), true)
})

test('override words and a call by name still cut through', () => {
  assert.equal(isEcho('stop', 'Please stop the exercise if you feel pain.'), false)
  assert.equal(isEcho('no', CHEST), false)
  assert.equal(overrides('hey mebo', 'Your heart rate looks steady.'), true)
  // ...but not MeBo saying its own name in the introduction.
  assert.equal(overrides('I am MeBo', INTRO), false)
})

test('nothing spoken means nothing to echo', () => {
  assert.equal(isEcho('I have chest pain', ''), false)
  assert.equal(isEcho('what about the second one', ''), false)
})

test('an ordinary follow-up made of common words is not dropped', () => {
  // The original MeBo case the stop-word list exists for.
  assert.equal(isEcho('what about the second one', 'The first one is ready and the second one is close.'), false)
})
