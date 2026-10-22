import { createHash, randomUUID } from 'node:crypto'
import { createFxAgent, createFxEngine, type FxAgent, type FxAgentHostTool, type FxEffort, type FxSession, type FxToolContext } from 'libfx'
import { local } from 'libfx/durable-local'
import { resolve } from 'node:path'
import { createTools, type ToolHost } from './tools'
import type { DesignDraftObserver } from './gateway-session'
import { piFetch } from './pi-transport'
import { libfxCatalog } from './pi-models'
import { bindLibfxSession, chatOfLibfxSession, getActiveTurn } from './journal'
import { createDraftContext } from './draft-context'
import { closeDraftCall, storedDraftObserver } from './draft-store'
import { turnBudget } from './turn-budget'
import { DEFAULT_MODEL, MAX_TURN_MODEL_STEPS, effectiveEffort, effectiveFast, effectiveModel, log, type SessionState } from './session'

export interface TurnContext { chatId: string; turnId: number }
export const STEP_LIMIT = `Turn stopped after ${MAX_TURN_MODEL_STEPS} model steps. Send a message to continue.`
export interface ChatRuntime {
  toolHost(chatId: string, turnId: number, signal: AbortSignal): Promise<ToolHost>
  watchDraft?(observer: DesignDraftObserver | undefined): DesignDraftObserver | undefined
}

export function modelStepName(sender: string, body: unknown): string {
  const prompt = (body as { prompt?: unknown } | null)?.prompt
  if (!Array.isArray(prompt)) return `${sender}:unread:${randomUUID()}`
  return `${sender}:${createHash('sha256').update(JSON.stringify(prompt)).digest('base64url').slice(0, 22)}`
}

function requestJson(body: unknown): unknown {
  if (typeof body === 'string') return JSON.parse(body)
  if (body instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(body))
  if (ArrayBuffer.isView(body)) return JSON.parse(new TextDecoder().decode(body))
  return null
}

export function turnModelStep(body: unknown): number {
  const prompt = (body as { prompt?: unknown })?.prompt
  if (!Array.isArray(prompt)) return 1
  let steps = 1
  for (let index = prompt.length - 1; index >= 0; index--) {
    const role = (prompt[index] as { role?: unknown })?.role
    if (role === 'user') break
    if (role === 'assistant') steps++
  }
  return steps
}

function chatFetch(chatId: () => Promise<string | null>, executionTurn: () => number | undefined,
  sender = 'parent', watchDraft?: ChatRuntime['watchDraft']): typeof fetch {
  return async (input, init) => {
    const turn = executionTurn()
    const id = await chatId()
    const url = new URL(input instanceof Request ? input.url : String(input))
    const modelRequest = (init?.method ?? 'GET').toUpperCase() === 'POST' && url.pathname.endsWith('/language-model')
    let observer: DesignDraftObserver | undefined
    if (modelRequest) {
      if (!id || !turn) throw new Error('Model request has no executing chat turn')
      const body = requestJson(init?.body)
      const [draft, steps] = await Promise.all([
        storedDraftObserver(id, turn).catch(() => undefined),
        turnBudget().reserve(id, turn, modelStepName(sender, body)),
      ])
      if (turnModelStep(body) > MAX_TURN_MODEL_STEPS || steps > MAX_TURN_MODEL_STEPS) {
        log(id, 'turn:step-limit', { steps: MAX_TURN_MODEL_STEPS })
        return Response.json({ error: { message: STEP_LIMIT } }, { status: 400 })
      }
      observer = watchDraft ? watchDraft(draft) : draft
    }
    return piFetch(input, init, observer)
  }
}

const libfxChats = new Map<string, string>()
async function chatOfRequest(sessionId: string | null): Promise<string | null> {
  if (!sessionId) return null
  const cached = libfxChats.get(sessionId)
  if (cached) return cached
  const chatId = await chatOfLibfxSession(sessionId)
  if (chatId) libfxChats.set(sessionId, chatId)
  return chatId
}

const IDEMPOTENT = new Set(['read_design', 'publish_design', 'web_fetch', 'read_tool_result', 'capability_search'])
const WRITES = new Set(['publish_design', 'edit_design'])
function turnContext(ctx: FxToolContext): TurnContext {
  const context = ctx.context as Partial<TurnContext> | undefined
  if (typeof context?.chatId !== 'string' || typeof context.turnId !== 'number') throw new Error('fx0 tool called without its chat context')
  return { chatId: context.chatId, turnId: context.turnId }
}

function chatTools(runtime: ChatRuntime, allowSubagent: boolean): FxAgentHostTool[] {
  return createTools(templateHost, { allowSubagent }).map(definition => ({
    ...definition, idempotent: IDEMPOTENT.has(definition.name), writes: WRITES.has(definition.name),
    async execute(input: unknown, ctx: FxToolContext) {
      const { chatId, turnId } = turnContext(ctx)
      const host = await runtime.toolHost(chatId, turnId, ctx.signal)
      const tool = createTools(host, { allowSubagent }).find(candidate => candidate.name === definition.name)
      if (!tool) throw new Error(`Unknown tool ${definition.name}`)
      try { return await tool.execute(input, ctx) } finally {
        if (definition.name === 'publish_design') await closeDraftCall(chatId, ctx.executionId).catch(() => {})
      }
    },
  }))
}

const templateHost = new Proxy({} as ToolHost, { get: () => () => { throw new Error('Tool definitions do not run') } })

export function durableAgent(runtime: ChatRuntime, instructions: string): FxAgent {
  const g = globalThis as unknown as { __fx0LibfxAgent?: FxAgent }
  if (g.__fx0LibfxAgent) return g.__fx0LibfxAgent
  const drafts = createDraftContext()
  g.__fx0LibfxAgent = createFxAgent({
    durability: local({ dir: resolve(process.env.FX0_DATA_DIR ?? '.data', 'sessions') }),
    apiKey: 'pi-transport', modelCatalog: libfxCatalog(),
    fetch: (input, init) => {
      const id = new Headers(init?.headers).get('x-session-id')
      return chatFetch(() => chatOfRequest(id), () => drafts.turn(id), 'parent', runtime.watchDraft)(input, init)
    },
    onEvent: event => drafts.observe(event), hooks: { onEvent: event => drafts.observe(event) },
    model: process.env.FX0_MODEL ?? DEFAULT_MODEL, instructions, tools: chatTools(runtime, true),
  })
  return g.__fx0LibfxAgent
}

function chatModel(host: SessionState) {
  return { id: effectiveModel(host), effort: effectiveEffort(host) as FxEffort, fast: effectiveFast(host) }
}

export function chatSessionOptions(host: SessionState, instructions: string, turnId: number) {
  return { model: chatModel(host), instructions, context: { chatId: host.id, turnId } satisfies TurnContext }
}

export async function chatSession(agent: FxAgent, host: SessionState, libfxSessionId: string | null,
  instructions: string, turnId: number): Promise<{ session: FxSession; libfxSessionId: string }> {
  const id = libfxSessionId ?? await bindLibfxSession(host.id, await agent.newSessionId())
  libfxChats.set(id, host.id)
  return { session: agent.session(id, chatSessionOptions(host, instructions, turnId)), libfxSessionId: id }
}

export async function runSubagent(runtime: ChatRuntime, host: SessionState, turnId: number,
  instructions: string, task: string, signal: AbortSignal): Promise<string> {
  const active = await getActiveTurn(host.id)
  const pinned = active?.id === turnId ? active.settings : undefined
  const engine = await createFxEngine({
    apiKey: 'pi-transport', modelCatalog: libfxCatalog(),
    fetch: chatFetch(async () => host.id, () => turnId, `subagent:${crypto.randomUUID()}`, runtime.watchDraft),
    model: pinned ? { id: pinned.model, effort: pinned.effort as FxEffort, fast: pinned.fast } : chatModel(host),
    instructions,
    tools: createTools(await runtime.toolHost(host.id, turnId, signal), { allowSubagent: false }).map(tool => ({
      ...tool,
      async execute(input: unknown, ctx: FxToolContext) {
        try { return await tool.execute(input, ctx) } finally {
          if (tool.name === 'publish_design') await closeDraftCall(host.id, ctx.executionId).catch(() => {})
        }
      },
    })),
  })
  try {
    const turn = engine.prompt(task, { signal })
    let text = ''
    for await (const event of turn) if (event.type === 'text_delta') text += event.delta
    const result = await turn.result
    if (result.stopReason === 'refused') throw new Error('The model refused the task')
    return text || '(subagent finished with no text output; check its tool calls above)'
  } finally { await engine.close().catch(() => {}) }
}
