import type { ThinkingLevel, ToolCall } from '@earendil-works/pi-ai'
import { findModel, libfxCatalog, piModels } from './pi-models'
import { piContext, piReplayMetadata, type ModelRequest } from './pi-context'
import { htmlFieldExtractor, type DesignDraftObserver } from './gateway-session'

export async function piFetch(input: RequestInfo | URL, init?: RequestInit, observer?: DesignDraftObserver): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method === 'GET' && url.pathname.endsWith('/models')) return Response.json({ data: libfxCatalog() })
  if (method !== 'POST' || !url.pathname.endsWith('/language-model')) throw new Error('Unsupported libfx model transport request')
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const model = findModel(headers.get('ai-language-model-id') ?? '')
  const request = await new Response(init?.body).json() as ModelRequest
  const effort = request.reasoning
  const abort = new AbortController()
  const signal = init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal
  const stream = piModels.streamSimple(model, piContext(request, model), {
    signal,
    maxTokens: request.maxOutputTokens,
    reasoning: typeof effort === 'string' && effort !== 'off' ? effort as ThinkingLevel : undefined,
    toolChoice: request.toolChoice?.type === 'none' ? 'none' : 'auto',
  })
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    cancel() { abort.abort() },
    async start(controller) {
      const send = (value: object) => { if (!signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)) }
      const calls = new Map<number, ToolCall>()
      const drafts = new Map<number, (delta: string) => void>()
      try {
        for await (const event of stream) {
          if (event.type === 'text_start' || event.type === 'thinking_start') send({ type: event.type === 'text_start' ? 'text-start' : 'reasoning-start', id: String(event.contentIndex) })
          if (event.type === 'text_delta' || event.type === 'thinking_delta') send({ type: event.type === 'text_delta' ? 'text-delta' : 'reasoning-delta', id: String(event.contentIndex), delta: event.delta })
          if (event.type === 'text_end' || event.type === 'thinking_end') send({ type: event.type === 'text_end' ? 'text-end' : 'reasoning-end', id: String(event.contentIndex),
            providerMetadata: piReplayMetadata(model, event.partial.content[event.contentIndex]) })
          if (event.type === 'toolcall_start' || event.type === 'toolcall_delta') {
            const call = event.partial.content[event.contentIndex]
            if (call?.type !== 'toolCall') continue
            if (!calls.has(event.contentIndex)) {
              calls.set(event.contentIndex, call)
              send({ type: 'tool-input-start', id: call.id, toolName: call.name })
              if (call.name === 'publish_design' && observer) drafts.set(event.contentIndex, htmlFieldExtractor(chunk => observer.delta(call.id, chunk)))
            }
            if (event.type === 'toolcall_delta') {
              send({ type: 'tool-input-delta', id: call.id, delta: event.delta })
              drafts.get(event.contentIndex)?.(event.delta)
            }
          }
          if (event.type === 'toolcall_end') {
            send({ type: 'tool-input-end', id: event.toolCall.id })
            send({ type: 'tool-call', toolCallId: event.toolCall.id, toolName: event.toolCall.name, input: JSON.stringify(event.toolCall.arguments),
              providerMetadata: piReplayMetadata(model, event.toolCall) })
            if (event.toolCall.name === 'publish_design') await observer?.end?.(event.toolCall.id)
          }
          if (event.type === 'error') throw new Error(event.reason === 'aborted' ? 'Generation cancelled' : 'Provider request failed; check provider credentials and quota')
          if (event.type === 'done') {
            const usage = event.message.usage
            const reason = event.reason === 'toolUse' ? 'tool-calls' : event.reason
            send({ type: 'finish', finishReason: { unified: reason, raw: event.message.rawStopReason ?? reason }, usage: {
              inputTokens: { total: usage.input + usage.cacheRead + usage.cacheWrite, noCache: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
              outputTokens: { total: usage.output, reasoning: usage.reasoning },
            } })
          }
        }
        if (!signal.aborted) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }
      } catch (error) {
        await observer?.abort?.()
        if (!signal.aborted) controller.error(error)
      }
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}
