// Shared event protocol between the session host and clients.
// Both SSE routes and the POST turn stream carry these items.

export interface SessionView {
  artifactRevision: number
}

export interface StreamItem {
  type:
    | 'accepted'
    | 'user'
    | 'turn_start'
    | 'text'
    | 'tool_start'
    | 'tool_input'
    | 'tool_end'
    | 'status'
    | 'artifact'
    | 'heartbeat'
    | 'question'
    | 'question_resolved'
    | 'reasoning'
    | 'done'
    | 'error'
    | 'design_draft'
  seq?: number
  at?: number
  /** Message id this item belongs to (turn lifecycle and user items). */
  id?: number
  /** Active turn joined by a steered message. */
  turnId?: number
  clientId?: string
  author?: string
  text?: string
  delta?: string
  /** Provisional draft generation, separate from the transcript journal. */
  draftId?: string
  draftRevision?: number
  draftOffset?: number
  draftClosed?: boolean
  draftPublished?: boolean
  name?: string
  command?: string
  callId?: number
  durationMs?: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
  isError?: boolean
  content?: string
  stopReason?: string
  artifactRevision?: number
  qid?: number
  instance?: string
  /** Count only — image bytes are never broadcast over the chat stream. */
  imageCount?: number
  // Small JPEG data URLs of the attached images, so a reload still shows them.
  imagePreviews?: string[]
  // On the prompt that created the chat with a DESIGN.md; the text is not broadcast.
  designMd?: { name: string; source: string }
  questions?: { question: string; options: { label: string; description?: string }[] }[]
  answers?: Record<string, string>
  cancelled?: boolean
}

export interface SessionInfo {
  trialChat?: true
  id: string
  title: string | null
  createdAt: number
  lastActivity: number
  busy: boolean
  // The chat's stored picker settings, so switching to it needs no settings request.
  generation?: { model: string; effort: string; fast: boolean }
}

export interface SessionPage {
  sessions: SessionInfo[]
  nextCursor: string | null
  now?: number
}
