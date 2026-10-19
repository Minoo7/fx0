// A chat ID as fx0 stores and checks it. Pure, so the browser uses the same rule.
export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id)
}

// What a page URL opens, by the rule the server's first paint uses: no `s` is a
// new chat, and an `s` that cannot name a chat is a new chat with a notice.
export type UrlChat = { kind: 'new' } | { kind: 'chat'; id: string } | { kind: 'invalid' }

export function urlChat(search: string): UrlChat {
  const requested = new URLSearchParams(search).get('s')
  if (requested === null) return { kind: 'new' }
  return validSessionId(requested) ? { kind: 'chat', id: requested } : { kind: 'invalid' }
}

export function sanitizeSessionId(raw: string | null | undefined): string {
  const id = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40)
  return id || 'lobby'
}
