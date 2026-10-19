// Bind transport to the prompt libfx actually executes, including an open turn
// restored in a fresh worker. Submitted prompts may still be waiting in its queue.
export function createDraftContext() {
  const turns = new Map<string, number>()
  const setTurn = (sessionId: string, value: unknown) => {
    const match = typeof value === 'string' ? /^m([1-9][0-9]*)$/.exec(value) : null
    if (!match || !Number.isSafeInteger(Number(match[1]))) return false
    turns.set(sessionId, Number(match[1]))
    if (turns.size > 200) turns.delete(turns.keys().next().value!)
    return true
  }
  return {
    observe(event: { type: string; message?: unknown; sessionId?: string; data?: unknown }) {
      if (event.type === 'journal.restore' && event.sessionId) {
        const data = event.data as { resumable?: boolean; openTurnId?: unknown } | undefined
        if (!data?.resumable || !setTurn(event.sessionId, data.openTurnId)) turns.delete(event.sessionId)
        return
      }
      if (event.type !== 'acp.send') return
      const message = event.message as { method?: string; params?: { sessionId?: string; _meta?: { fx?: { turnId?: string } } } } | undefined
      if (message?.method !== 'session/prompt' || !message.params?.sessionId) return
      // Recovery omits turnId; journal.restore already selected that open turn.
      setTurn(message.params.sessionId, message.params._meta?.fx?.turnId)
    },
    turn(sessionId: string | null) { return sessionId ? turns.get(sessionId) : undefined },
  }
}
