export function sanitizeSessionId(raw: string | null | undefined): string {
  const id = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40)
  return id || 'lobby'
}
