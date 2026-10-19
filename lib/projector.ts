import type { FxAgent, FxStreamLine } from 'libfx'
import { tail } from './tools'
import {
  clearActiveTurn,
  getActiveTurn,
  projectEvents,
  projectedCursor,
  readDesignArtifact,
  readEvents,
  readSession,
  readSessionView,
  setActiveTurn,
  type ActiveTurn,
  type TurnSettings,
} from './journal'
import { recordGeneration, recordTurn } from './history'
import { readExecutionFunding } from './turn-credential'
import { effectiveEffort, effectiveFast, effectiveModel, INSTANCE, log, type SessionState } from './session'
import type { StreamItem } from './events'
import { TRIAL_MODEL } from './trial-policy'

// The projector copies a chat's libfx stream into fx0's transcript, the
// StreamItem protocol the page already renders. Any route following a chat runs
// one; the cursor check in projectEvents makes each line land once.

type Entry = Omit<StreamItem, 'seq'>

// fx0 sends each message with messageId `m<message id>`.
function messageNumber(messageId: unknown): number | null {
  const match = typeof messageId === 'string' ? /^m([0-9]+)$/.exec(messageId) : null
  return match ? Number(match[1]) : null
}

// The message whose turn a line belongs to.
export function messageIdOf(line: object): number | null {
  return messageNumber((line as { messageId?: unknown }).messageId)
}

export function toolLabel(line: Record<string, unknown>): string | undefined {
  const input = line.input as Record<string, unknown> | undefined
  if (line.name === 'publish_design') {
    const html = typeof input?.html === 'string' ? input.html : null
    return html == null ? 'complete HTML document' : `complete HTML document (${Buffer.byteLength(html, 'utf8')} bytes)`
  }
  if (input && typeof input === 'object') {
    const pick = (name: string) => (typeof input[name] === 'string' ? (input[name] as string) : null)
    const path = pick('path')
    const pattern = pick('pattern')
    let label = pick('command') ?? (pattern && path ? `${pattern} in ${path}` : null) ?? path ?? pick('url') ?? pick('query') ?? pick('task') ?? undefined
    if (!label) {
      const json = JSON.stringify(input)
      label = json.length > 120 ? json.slice(0, 120) + '…' : json
    }
    return label.length > 300 ? label.slice(0, 300) + '…' : label
  }
  if (line.inputTruncated === true && typeof line.inputPreview === 'string') return line.inputPreview.slice(0, 300) + '…'
  return undefined
}

// The transcript items for one libfx line. Pure: the turn bookkeeping that the
// line implies happens after its batch commits.
export function itemsOf(line: FxStreamLine, at: number): Entry[] {
  const id = messageIdOf(line)
  if (id == null) return []
  switch (line.type) {
    case 'turn_start':
      return [{ type: 'turn_start', id, turnId: id, instance: INSTANCE, at }]
    case 'turn_resume':
      return [{ type: 'status', id, turnId: id, text: 'continuing after an interruption…', at }]
    case 'user_message': {
      // A message that joined this turn, which the model now sees.
      const joined = messageNumber(line.id)
      return joined == null || joined === id ? [] : [{ type: 'status', id: joined, turnId: id, text: 'steering the running turn', at }]
    }
    case 'text_delta':
      return line.delta ? [{ type: 'text', delta: line.delta, turnId: id, at }] : []
    case 'reasoning_delta':
      return line.delta ? [{ type: 'reasoning', delta: line.delta, turnId: id, at }] : []
    case 'tool_start':
      return [{ type: 'tool_start', name: line.name || 'tool', command: toolLabel(line as Record<string, unknown>), turnId: id, at }]
    case 'tool_end':
      return [{ type: 'tool_end', name: line.name || 'tool', isError: line.isError === true, content: typeof line.content === 'string' ? tail(line.content) : undefined, turnId: id, at }]
    case 'turn_end': {
      const failed = line.stopReason === 'error' || line.stopReason === 'unknown' || (line.stopReason === 'refused' && line.error?.message)
      return [failed
        ? { type: 'error', id, turnId: id, text: line.error?.message || 'This message did not finish. Resend to retry.', at }
        : { type: 'done', id, turnId: id, stopReason: line.stopReason, usage: line.usage as StreamItem['usage'], at }]
    }
    default:
      return []
  }
}

// Adjacent deltas of one kind and turn become one item, so a batch writes a few
// transcript entries, not one per token.
export function mergeDeltas(entries: Entry[]): Entry[] {
  const out: Entry[] = []
  for (const entry of entries) {
    const last = out[out.length - 1]
    if (last && (entry.type === 'text' || entry.type === 'reasoning') && last.type === entry.type && last.turnId === entry.turnId) {
      out[out.length - 1] = { ...last, delta: `${last.delta ?? ''}${entry.delta ?? ''}` }
    } else {
      out.push(entry)
    }
  }
  return out
}

// A prompt is sent as `[author] text`; history keeps the text.
function promptText(input: string | undefined): string {
  return (input ?? '').replace(/^\[[^\]]*\] /, '')
}

async function readSettings(host: SessionState) {
  const stored = await readSession(host.id)
  host.preferredModel = stored?.preferredModel ?? null
  host.preferredEffort = stored?.preferredEffort ?? null
  host.preferredFast = stored?.preferredFast ?? null
  return stored
}

// A sponsored turn always runs the free model, whatever the chat has selected.
function turnSettings(host: SessionState, sponsored: boolean): TurnSettings {
  return sponsored
    ? { model: TRIAL_MODEL, effort: 'low', fast: true }
    : { model: effectiveModel(host), effort: effectiveEffort(host), fast: effectiveFast(host) }
}

async function startTurn(host: SessionState, id: number, input: string | undefined, startSeq: number): Promise<void> {
  const [funding] = await Promise.all([readExecutionFunding(host.id, id), readSettings(host)])
  const credential = funding.ok ? funding.credential : null
  const sponsored = !!credential && 'kind' in credential
  const turn: ActiveTurn = {
    id,
    startedAt: Date.now(),
    billingTeamId: credential?.teamId ?? null,
    ...(sponsored ? { sponsored: true as const } : {}),
    prompt: promptText(input),
    startSeq,
    settings: turnSettings(host, sponsored),
  }
  await setActiveTurn(host.id, turn)
}

async function endTurn(host: SessionState, terminal: StreamItem): Promise<void> {
  const id = terminal.id!
  const active = await getActiveTurn(host.id)
  await clearActiveTurn(host.id, id)
  const turn = active?.id === id ? active : null
  const stored = await readSettings(host)
  const settings = turn?.settings ?? turnSettings(host, !!turn?.sponsored)
  const events = turn ? await readEvents(host.id, Math.max(0, turn.startSeq - 1)) : []
  const response = events.filter((item) => item.type === 'text' && item.turnId === id).map((item) => item.delta ?? '').join('')
  // One history version per turn: the design as the turn left it, if it
  // published one and no later turn has published since.
  if (stored?.artifactTurn === id) {
    const [view, html] = await Promise.all([readSessionView(host.id), readDesignArtifact(host.id)])
    if (html != null) {
      await recordGeneration(host.id, view.artifactRevision, id, html).catch(() =>
        log(host.id, 'history:generation:error', { revision: view.artifactRevision }))
    }
  }
  await recordTurn({
    sessionId: host.id,
    turnId: id,
    prompt: turn?.prompt ?? '',
    response,
    model: settings.model,
    effort: settings.effort,
    fast: settings.fast,
    status: terminal.type === 'done' ? 'done' : 'error',
    stopReason: terminal.type === 'done' ? terminal.stopReason ?? null : null,
    billingTeamId: turn?.billingTeamId ?? null,
    inputTokens: terminal.usage?.inputTokens ?? null,
    outputTokens: terminal.usage?.outputTokens ?? null,
    startedAt: turn?.startedAt ?? Date.now(),
  }).catch(() => log(host.id, 'history:turn:error', { id }))
}

const BATCH_MS = 40

export interface FollowOptions {
  /** Stops following when this aborts. */
  signal?: AbortSignal
  /** Stops after this long with no line while no turn is running. */
  idleMs: number
}

// Follows the chat's libfx stream from the projected cursor. Returns when the
// chat stays idle for idleMs, when the signal aborts, or when another projector
// moved the cursor first (that one carries on).
export async function project(agent: FxAgent, host: SessionState, libfxSessionId: string, options: FollowOptions): Promise<void> {
  let cursor = await projectedCursor(host.id)
  const reader = agent.session(libfxSessionId).stream(cursor).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pending: { line: FxStreamLine; entries: Entry[] }[] = []
  let running = (await getActiveTurn(host.id)) != null
  let stopped = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    stopped = true
    void reader.cancel().catch(() => {})
  }
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = running ? null : setTimeout(stop, options.idleMs)
  }
  options.signal?.addEventListener('abort', stop, { once: true })
  armIdle()

  const commit = async (): Promise<boolean> => {
    const batch = pending
    pending = []
    if (!batch.length) return true
    const toCursor = batch[batch.length - 1].line.cursor ?? cursor
    const entries = mergeDeltas(batch.flatMap((part) => part.entries))
    const items = await projectEvents(host.id, cursor, toCursor, entries)
    if (!items) return false
    cursor = toCursor
    for (const item of items) {
      if (item.type === 'turn_start') {
        running = true
        const line = batch.find((part) => part.line.type === 'turn_start' && messageIdOf(part.line) === item.id)?.line
        await startTurn(host, item.id!, line?.type === 'turn_start' ? line.input : undefined, item.seq ?? 0)
      } else if (item.type === 'done' || item.type === 'error') {
        running = false
        await endTurn(host, item)
      }
    }
    armIdle()
    return true
  }

  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let committing: Promise<boolean> = Promise.resolve(true)
  const scheduleCommit = () => {
    flushTimer ??= setTimeout(() => {
      flushTimer = null
      committing = committing.then((ok) => (ok ? commit() : false)).then((ok) => {
        if (!ok) stop()
        return ok
      })
    }, BATCH_MS)
  }

  try {
    while (!stopped) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const text = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!text) continue
        let line: FxStreamLine
        try { line = JSON.parse(text) as FxStreamLine } catch { continue }
        pending.push({ line, entries: itemsOf(line, Date.now()) })
        if (line.type === 'turn_start') running = true
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = null
        scheduleCommit()
      }
    }
  } catch (error) {
    if (!stopped) log(host.id, 'projector:error', { error: String((error as Error)?.message ?? error).slice(0, 200) })
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
      committing = committing.then((ok) => (ok ? commit() : false))
    }
    await committing.catch(() => false)
    options.signal?.removeEventListener('abort', stop)
  }
}
