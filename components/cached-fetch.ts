import { fetchUi } from './auth-ui'

// Stale-while-revalidate for small per-user JSON (team list, balance). Memory
// first, then session storage, so a reload or a second component paints the
// last known value at once. Keys start with `fx0:` so sign-out clears them.
interface Entry<T> { at: number; value: T }

const memory = new Map<string, Entry<unknown>>()
const inFlight = new Map<string, Promise<unknown>>()

export function readCached<T>(key: string): Entry<T> | null {
  const hit = memory.get(key) as Entry<T> | undefined
  if (hit) return hit
  try {
    const raw = window.sessionStorage.getItem(key)
    const stored = raw ? JSON.parse(raw) as Entry<T> : null
    if (stored && typeof stored.at === 'number') {
      memory.set(key, stored)
      return stored
    }
  } catch { /* Storage is optional. */ }
  return null
}

function write<T>(key: string, value: T): Entry<T> {
  const entry = { at: Date.now(), value }
  memory.set(key, entry)
  try { window.sessionStorage.setItem(key, JSON.stringify(entry)) } catch { /* Storage is optional. */ }
  return entry
}

export function invalidateCached(prefix: string): void {
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key)
  for (const key of [...inFlight.keys()]) if (key.startsWith(prefix)) inFlight.delete(key)
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index--) {
      const key = window.sessionStorage.key(index)
      if (key?.startsWith(prefix)) window.sessionStorage.removeItem(key)
    }
  } catch { /* Storage is optional. */ }
}

// Resolves with a fresh value when the cached one is older than maxAgeMs, or with
// the cached value otherwise. Concurrent callers for one key share one request.
export async function loadCached<T>(key: string, url: string, maxAgeMs: number): Promise<T | null> {
  const cached = readCached<T>(key)
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.value
  let pending = inFlight.get(key) as Promise<T | null> | undefined
  if (!pending) {
    pending = fetchUi(url)
      .then(async (response) => {
        const value = response.ok ? await response.json() as T : cached?.value ?? null
        if (inFlight.get(key) !== pending) return null
        return response.ok ? write(key, value as T).value : value
      })
      .catch(() => inFlight.get(key) === pending ? cached?.value ?? null : null)
      .finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key) })
    inFlight.set(key, pending)
  }
  return pending
}
