import assert from 'node:assert/strict'
import test from 'node:test'
import { createEventDelivery } from '../lib/event-delivery.ts'
import { applyDesignDraft, EMPTY_DRAFT } from '../lib/design-draft.ts'
import { compactTranscript } from '../lib/transcript.ts'

test('POST can paint a response before GET arrives; overlap never duplicates it', () => {
  const delivery = createEventDelivery(40)
  const user = { type: 'user', seq: 41, id: 2, text: 'Hello' }
  const start = { type: 'turn_start', seq: 42, id: 2, turnId: 2 }
  const text = { type: 'text', seq: 43, turnId: 2, delta: 'Fast response' }
  let transcript = compactTranscript([], { artifactRevision: 0 })
  for (const item of [user, start, text]) {
    for (const ready of delivery.push(item)) transcript = compactTranscript([ready], transcript.view, transcript)
  }
  assert.equal(transcript.entries.at(-1).text, 'Fast response')
  for (const item of [user, start, text]) assert.deepEqual(delivery.push(item), [])
  assert.equal(delivery.cursor, 43)
})

test('a faster later event waits for gaps; reconnect resumes from the contiguous prefix', () => {
  const delivery = createEventDelivery(10)
  const events = [11, 12, 13, 14].map(seq => ({ type: 'text', seq, delta: String(seq) }))
  assert.deepEqual(delivery.push(events[2]), [])
  assert.equal(delivery.cursor, 10)
  assert.deepEqual(delivery.push(events[0]), [events[0]])
  assert.equal(delivery.cursor, 11)
  assert.deepEqual(delivery.push(events[3]), [])
  assert.deepEqual(delivery.push(events[1]), events.slice(1))
  assert.equal(delivery.cursor, 14)
  assert.deepEqual(delivery.push(events[1]), [])
})

test('draft bytes wait for their journal watermark and future artifact revision', () => {
  const delivery = createEventDelivery(10, 1)
  const draft = { type: 'design_draft', draftId: 'next', draftRevision: 2, turnId: 2,
    artifactRevision: 2, draftOffset: 0, delta: '<body>Hello' }
  assert.deepEqual(delivery.push(draft, 11), [])
  const user = { type: 'user', seq: 11, id: 2 }
  assert.deepEqual(delivery.push(user), [user])
  const artifact = { type: 'artifact', seq: 12, artifactRevision: 2 }
  assert.deepEqual(delivery.push(artifact), [artifact, draft])
})

test('a terminal event wins over late provisional bytes from either stream', () => {
  const delivery = createEventDelivery(10)
  const draft = { type: 'design_draft', draftId: 'old', draftRevision: 1, turnId: 1,
    artifactRevision: 0, draftOffset: 0, delta: '<body>old' }
  let state = EMPTY_DRAFT
  for (const item of delivery.push(draft)) state = applyDesignDraft(state, item, 0)
  for (const item of delivery.push({ type: 'done', seq: 11, id: 1, turnId: 1 })) state = applyDesignDraft(state, item, 0)
  for (const item of delivery.push(draft)) state = applyDesignDraft(state, item, 0)
  assert.equal(state.draft, null)
})

test('restoring a snapshot clears buffered events and provisional bytes from the previous view', () => {
  const delivery = createEventDelivery(10)
  delivery.push({ type: 'text', seq: 12, delta: 'old' })
  delivery.push({ type: 'design_draft', artifactRevision: 1, delta: 'old' }, 12)
  delivery.reset(50, 2)
  assert.deepEqual(delivery.push({ type: 'text', seq: 11 }), [])
  const next = { type: 'text', seq: 51, delta: 'new' }
  assert.deepEqual(delivery.push(next), [next])
  assert.equal(delivery.cursor, 51)
})
