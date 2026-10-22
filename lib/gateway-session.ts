export interface DesignDraftObserver {
  delta(callId: string, chunk: string): void
  end?(callId: string): Promise<void> | void
  abort?(): Promise<void> | void
}

export function htmlFieldExtractor(emit: (chunk: string) => void): (delta: string) => void {
  let raw = ''
  let pos = -1
  let done = false
  const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }
  return delta => {
    if (done) return
    raw += delta
    if (pos < 0) {
      const start = /"html"\s*:\s*"/.exec(raw)
      if (!start) return
      pos = start.index + start[0].length
    }
    let out = ''
    while (pos < raw.length) {
      const char = raw[pos]
      if (char === '"') { done = true; break }
      if (char !== '\\') { out += char; pos++; continue }
      if (pos + 1 >= raw.length) break
      const next = raw[pos + 1]
      if (next === 'u') {
        if (pos + 6 > raw.length) break
        out += String.fromCharCode(parseInt(raw.slice(pos + 2, pos + 6), 16))
        pos += 6
        continue
      }
      out += escapes[next] ?? next
      pos += 2
    }
    if (out) emit(out)
  }
}
