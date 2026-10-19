import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The stream's only boundaries are the Redis journal and the draft store.
const fake = globalThis.__fx0EventStream = { localEvents: new EventEmitter(), reads: 0, read: null }
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const fakes = {
  './journal': dataUrl(`export const localEvents = globalThis.__fx0EventStream.localEvents
export const readEvents = async () => { const fake = globalThis.__fx0EventStream; fake.reads += 1; return fake.read ? fake.read() : [] }`),
  './draft-store': dataUrl('export const readDraft = async () => null'),
}
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/lib/event-stream.ts') && fakes[specifier]) return { url: fakes[specifier], shortCircuit: true }
  return next(specifier, context)
} })
const { createSessionEventStream } = await import('../lib/event-stream.ts')

test('a stream with a lifetime ends cleanly on its own and stops reading and listening', async () => {
  const started = Date.now()
  const reader = createSessionEventStream('chat-a', { maxLifetimeMs: 80 }).getReader()
  assert.equal(fake.localEvents.listenerCount('chat-a'), 1)
  const { done } = await reader.read()
  assert.equal(done, true)
  assert.ok(Date.now() - started >= 70)
  assert.equal(fake.localEvents.listenerCount('chat-a'), 0)
  assert.equal(fake.localEvents.listenerCount('chat-a:live'), 0)
  // Polling backs off from 150ms, so a stream still running would read again here.
  const reads = fake.reads
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(fake.reads, reads)
})

// A journal read the test fails by hand, and the rejections nothing handled.
function pendingRead(t) {
  let fail
  fake.read = () => new Promise((_resolve, reject) => { fail = reject })
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => {
    fake.read = null
    process.off('unhandledRejection', onUnhandled)
  })
  return {
    unhandled,
    async fail() {
      fail(new Error('redis down'))
      await new Promise((resolve) => setTimeout(resolve, 50))
    },
  }
}

test('a read that fails after the client left is dropped, not left unhandled', async (t) => {
  const read = pendingRead(t)
  const reader = createSessionEventStream('chat-left').getReader()
  assert.equal(fake.localEvents.listenerCount('chat-left'), 1)
  await reader.cancel()
  await read.fail()
  assert.deepEqual(read.unhandled, [])
  const reads = fake.reads
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(fake.reads, reads, 'a stopped stream reads no more')
})

test('a read that fails after a terminal item closed the stream is dropped, not left unhandled', async (t) => {
  const read = pendingRead(t)
  const reader = createSessionEventStream('chat-ended', { closeWhen: (item) => item.type === 'done' }).getReader()
  fake.localEvents.emit('chat-ended', { type: 'done', seq: 1, turnId: 1 })
  const { value } = await reader.read()
  assert.match(value, /"type":"done"/)
  assert.equal((await reader.read()).done, true)
  await read.fail()
  assert.deepEqual(read.unhandled, [])
})

test('a read that fails while the stream is open still ends it with an error line', async (t) => {
  const read = pendingRead(t)
  const reader = createSessionEventStream('chat-open').getReader()
  await read.fail()
  const { value } = await reader.read()
  assert.equal(value, `data: ${JSON.stringify({ type: 'error', text: 'event journal unavailable: redis down' })}\n\n`)
  assert.equal((await reader.read()).done, true)
  assert.deepEqual(read.unhandled, [])
})
