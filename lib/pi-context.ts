import type { Api, AssistantMessage, Context, JsonObject, Message, Model, TSchema, Tool, Usage } from '@earendil-works/pi-ai'

interface Part {
  type: string
  text?: string
  data?: string
  mediaType?: string
  mimeType?: string
  toolCallId?: string
  toolName?: string
  input?: JsonObject
  output?: { type?: string; value?: unknown }
  providerOptions?: { pi?: PiReplay }
}
interface PiReplay {
  api: Api; provider: string; model: string
  thinkingSignature?: string; redacted?: boolean; textSignature?: string
  thoughtSignature?: string; namespace?: string
}
export function piReplayMetadata(model: Model<Api>, part: AssistantMessage['content'][number]) {
  const pi: PiReplay = { api: model.api, provider: model.provider, model: model.id }
  if (part.type === 'thinking') { pi.thinkingSignature = part.thinkingSignature; pi.redacted = part.redacted }
  if (part.type === 'text') pi.textSignature = part.textSignature
  if (part.type === 'toolCall') { pi.thoughtSignature = part.thoughtSignature; pi.namespace = part.namespace }
  return { pi }
}
export interface ModelRequest {
  prompt: { role: string; content: string | Part[] }[]
  tools?: { type: string; name: string; description?: string; inputSchema: TSchema }[]
  toolChoice?: { type: string; toolName?: string }
  maxOutputTokens?: number
  reasoning?: string
  providerOptions?: Record<string, Record<string, unknown>>
}
export function emptyUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function image(part: Part): { type: 'image'; data: string; mimeType: string } {
  const data = part.data ?? ''
  const match = /^data:([^;]+);base64,(.+)$/.exec(data)
  return { type: 'image' as const, data: match?.[2] ?? data, mimeType: match?.[1] ?? part.mediaType ?? part.mimeType ?? 'image/png' }
}

export function piContext(request: ModelRequest, model: Model<Api>): Context {
  const messages: Message[] = []
  const tools: Tool[] = (request.tools ?? []).filter(tool => tool.type === 'function')
    .map(tool => ({ name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema }))
  for (const message of request.prompt) {
    const parts: Part[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
    const timestamp = Date.now()
    if (message.role === 'system') {
      messages.push({ role: 'system', content: parts.map(p => p.text ?? '').join('\n'), timestamp })
    } else if (message.role === 'user') {
      messages.push({ role: 'user', timestamp, content: parts.map(p => p.type === 'file' || p.type === 'image'
        ? image(p) : { type: 'text' as const, text: p.text ?? '' }) })
    } else if (message.role === 'assistant') {
      const content = parts.flatMap<AssistantMessage['content'][number]>(p => {
        const replay = p.providerOptions?.pi
        if (p.type === 'text') return [{ type: 'text', text: p.text ?? '', textSignature: replay?.textSignature }]
        if (p.type === 'reasoning' && replay) return [{ type: 'thinking', thinking: p.text ?? '', thinkingSignature: replay.thinkingSignature, redacted: replay.redacted }]
        if (p.type === 'tool-call') return [{ type: 'toolCall', id: p.toolCallId!, name: p.toolName!, arguments: p.input ?? {},
          thoughtSignature: replay?.thoughtSignature, namespace: replay?.namespace }]
        return []
      })
      const replay = parts.find(p => p.providerOptions?.pi)?.providerOptions?.pi
      messages.push({ role: 'assistant', content, timestamp, api: replay?.api ?? model.api, provider: replay?.provider ?? model.provider, model: replay?.model ?? model.id,
        usage: emptyUsage(), stopReason: content.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop' })
    } else if (message.role === 'tool') {
      for (const p of parts) {
        const value = p.output?.value
        messages.push({ role: 'toolResult', toolCallId: p.toolCallId!, toolName: p.toolName!, timestamp,
          isError: p.output?.type?.startsWith('error') ?? false,
          content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }] })
      }
    }
  }
  return { messages, tools }
}
