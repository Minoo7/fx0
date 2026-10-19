import type { StreamItem } from './events'

export interface DesignDraft {
  id: string
  revision: number
  turnId: number
  html: string
}

export interface DraftState {
  draft: DesignDraft | null
  revision: number
  closedRevision: number
  closedTurn: number
}

export const EMPTY_DRAFT: DraftState = { draft: null, revision: 0, closedRevision: 0, closedTurn: 0 }

/** Offsets are UTF-16 positions, as in String.slice, including across JSON escapes. */
export function applyDesignDraft(state: DraftState, item: StreamItem, artifactRevision: number): DraftState {
  if (item.type === 'done' || item.type === 'error') {
    const turn = item.turnId ?? item.id ?? 0
    return { ...state, closedTurn: Math.max(state.closedTurn, turn), draft: state.draft?.turnId === turn ? null : state.draft }
  }
  if (item.type === 'artifact') return { ...state, draft: null, closedRevision: state.revision }
  if (item.type !== 'design_draft') return state
  const { draftId, draftRevision: revision, turnId, draftOffset: offset, delta } = item
  if (!draftId || !Number.isSafeInteger(revision) || revision! < state.revision || !turnId) return state
  if (revision! <= state.closedRevision) return state
  if (item.draftClosed || turnId <= state.closedTurn || item.artifactRevision !== artifactRevision) {
    // A shared close can arrive before the journal's artifact event. Hold the
    // last picture until that event loads its interactive replacement.
    return { ...state, revision: revision!, closedRevision: revision!,
      draft: item.draftPublished && state.draft?.id === draftId ? state.draft : null }
  }
  if (revision === state.revision && !state.draft) return state
  if (typeof delta !== 'string' || !Number.isSafeInteger(offset) || offset! < 0) return state
  const current = state.draft
  if (!current || current.id !== draftId || current.revision !== revision) {
    if (offset !== 0) return state
    return { ...state, revision: revision!, draft: { id: draftId, revision: revision!, turnId, html: delta } }
  }
  if (offset! > current.html.length) return state
  const overlap = Math.min(delta.length, current.html.length - offset!)
  if (current.html.slice(offset!, offset! + overlap) !== delta.slice(0, overlap)) return state
  if (overlap === delta.length) return state
  return { ...state, draft: { ...current, html: current.html + delta.slice(overlap) } }
}

/** Coalesce model bytes without leaving a timer behind at the tool boundary. */
export function createDraftBatch(write: (callId: string, delta: string) => Promise<void>) {
  const calls = new Map<string, { pending: string; timer: ReturnType<typeof setTimeout> | null; tail: Promise<void> }>()
  const flush = (id: string) => {
    const call = calls.get(id)
    if (!call) return Promise.resolve()
    if (call.timer) clearTimeout(call.timer)
    call.timer = null
    const delta = call.pending
    call.pending = ''
    if (delta) call.tail = call.tail.then(() => write(id, delta)).catch(() => {})
    return call.tail
  }
  return {
    delta(id: string, delta: string) {
      let call = calls.get(id)
      if (!call) calls.set(id, call = { pending: '', timer: null, tail: Promise.resolve() })
      call.pending += delta
      call.timer ??= setTimeout(() => { void flush(id) }, 150)
    },
    end: flush,
    async stop() {
      await Promise.all([...calls.keys()].map(flush))
      calls.clear()
    },
  }
}
