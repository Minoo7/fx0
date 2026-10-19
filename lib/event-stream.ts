import type { StreamItem } from './events'
import { localEvents, readEvents } from './journal'
import { readDraft, type DraftCursor } from './draft-store'

interface EventStreamOptions {
  afterSeq?: number
  // Longest idle gap between journal reads. A prompt's own stream keeps it short so
  // the first token after a long think lands fast; idle chat streams back off further.
  maxIdleMs?: number
  // Ends the stream cleanly after this long, so its function returns before the
  // platform's duration limit kills it. The client reconnects from its last seq.
  maxLifetimeMs?: number
  closeWhen?: (item: StreamItem) => boolean
  wake?: () => void
}

export function createSessionEventStream(sessionId: string, options: EventStreamOptions = {}): ReadableStream<string> {
  let cursor = Math.max(0, options.afterSeq ?? 0)
  let stopped = false
  let pollDelayMs = 100
  let polling = false
  let pollAgain = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let wakeTimer: ReturnType<typeof setInterval> | null = null
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  let onLocal: ((item: StreamItem) => void) | null = null
  let onLive: ((item: StreamItem) => void) | null = null
  let draftCursor: DraftCursor | undefined
  let running = false

  const stopTimers = () => {
    stopped = true
    if (pollTimer) clearTimeout(pollTimer)
    if (heartbeat) clearInterval(heartbeat)
    if (wakeTimer) clearInterval(wakeTimer)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    if (onLocal) localEvents.off(sessionId, onLocal)
    if (onLive) localEvents.off(`${sessionId}:live`, onLive)
  }

  return new ReadableStream<string>({
    start(controller) {
      const close = () => {
        if (stopped) return
        stopTimers()
        controller.close()
      }
      // Delivery is in seq order and exactly once: the cursor only advances, and any
      // item at or below it, from either source, has already been sent.
      const deliver = (item: StreamItem): boolean => {
        if (typeof item.seq === 'number') {
          if (item.seq <= cursor) return false
          cursor = item.seq
        }
        if (item.type === 'turn_start') running = true
        if (item.type === 'done' || item.type === 'error') running = false
        controller.enqueue(`id: ${item.seq ?? ''}\ndata: ${JSON.stringify(item)}\n\n`)
        if (options.closeWhen?.(item)) {
          close()
          return true
        }
        return false
      }
      const poll = async () => {
        if (stopped) return
        if (polling) {
          pollAgain = true
          return
        }
        polling = true
        if (pollTimer) clearTimeout(pollTimer)
        pollTimer = null
        try {
          const [items, draft] = await Promise.all([readEvents(sessionId, cursor), readDraft(sessionId, draftCursor).catch(() => null)])
          for (const item of items) {
            if (stopped || deliver(item)) return
          }
          if (stopped) return
          if (draft) {
            draftCursor = draft.cursor
            if (!draft.item.draftClosed) running = true
            deliver(draft.item)
          }
          pollDelayMs = items.length > 0 || draft ? 100 : Math.min(running ? 150 : options.maxIdleMs ?? 1000, Math.ceil(pollDelayMs * 1.5))
        } catch (error) {
          controller.enqueue(
            `data: ${JSON.stringify({ type: 'error', text: `event journal unavailable: ${String((error as Error)?.message ?? error)}` })}\n\n`,
          )
          close()
          return
        } finally {
          polling = false
        }
        if (stopped) return
        if (pollAgain) {
          pollAgain = false
          void poll()
          return
        }
        pollTimer = setTimeout(poll, pollDelayMs)
      }

      // Same-process commits arrive here as they land. The next item in sequence is
      // delivered at once; a gap means another instance wrote in between, so read
      // the journal now instead of waiting for the timer.
      onLocal = (item) => {
        if (stopped || typeof item.seq !== 'number' || item.seq <= cursor) return
        if (item.seq === cursor + 1) {
          deliver(item)
          pollDelayMs = 100
        } else {
          void poll()
        }
      }
      localEvents.on(sessionId, onLocal)
      // A local write wakes the shared reader; bytes always come from the store,
      // with its generation and offset, just as they do on another instance.
      onLive = (item) => {
        if (!stopped && item.type === 'design_draft') void poll()
      }
      localEvents.on(`${sessionId}:live`, onLive)

      void poll()
      heartbeat = setInterval(() => {
        if (!stopped) controller.enqueue(': ping\n\n')
      }, 15_000)
      if (options.wake) {
        options.wake()
        wakeTimer = setInterval(options.wake, 5_000)
      }
      if (options.maxLifetimeMs) lifetimeTimer = setTimeout(close, options.maxLifetimeMs)
    },
    cancel() {
      stopTimers()
    },
  })
}
