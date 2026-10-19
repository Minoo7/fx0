import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The stream's only boundaries are the Redis journal and the draft store.
const fake = globalThis.__fx0EventStream = { localEvents: new EventEmitter(), reads: 0 }
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`
const fakes = {
  './journal': dataUrl(`export const localEvents = globalThis.__fx0EventStream.localEvents
export const readEvents = async () => { globalThis.__fx0EventStream.reads += 1; return [] }`),
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
