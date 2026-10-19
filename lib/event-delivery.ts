import type { StreamItem } from './events'

// POST and GET can overlap and arrive in either order. Only a contiguous journal
// prefix can enter the transcript or become a reconnect cursor.
export function createEventDelivery(initialSeq = 0, initialRevision = 0) {
  let cursor = initialSeq
  let revision = initialRevision
  const pending = new Map<number, StreamItem>()
  let drafts: { item: StreamItem; after: number }[] = []
  return {
    get cursor() { return cursor },
    reset(seq: number, artifactRevision: number) {
      cursor = seq
      revision = artifactRevision
      pending.clear()
      drafts = []
    },
    push(item: StreamItem, after = cursor): StreamItem[] {
      const ready: StreamItem[] = []
      if (item.seq != null) {
        if (!Number.isSafeInteger(item.seq) || item.seq <= cursor) return ready
        if (!pending.has(item.seq)) pending.set(item.seq, item)
      } else if (item.type === 'design_draft') {
        // Provisional bytes have their own offset dedupe. They must still wait
        // for the journal prefix and artifact revision their stream has seen.
        drafts.push({ item, after })
      } else {
        return [item]
      }
      while (pending.has(cursor + 1)) {
        const next = pending.get(++cursor)!
        pending.delete(cursor)
        if (next.type === 'artifact') revision = Math.max(revision, next.artifactRevision ?? 0)
        ready.push(next)
      }
      const waiting: typeof drafts = []
      for (const draft of drafts) {
        if (draft.after <= cursor && (draft.item.artifactRevision ?? 0) <= revision) ready.push(draft.item)
        else waiting.push(draft)
      }
      drafts = waiting
      return ready
    },
  }
}
