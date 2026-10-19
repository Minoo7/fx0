import { registerHooks } from 'node:module'

// An in-memory stand-in for the Upstash commands lib/turn-credential.ts sends,
// in pipelines and directly. Values are kept as written.
export function memoryRedis() {
  const values = new Map()
  const hashes = new Map()
  const sets = new Map()
  const commands = {
    set(key, value) { values.set(key, value); return 'OK' },
    get(key) { return values.get(key) ?? null },
    hset(key, entries) { hashes.set(key, { ...(hashes.get(key) ?? {}), ...entries }); return 1 },
    hget(key, field) { return hashes.get(key)?.[field] ?? null },
    hlen(key) { return Object.keys(hashes.get(key) ?? {}).length },
    hkeys(key) { return Object.keys(hashes.get(key) ?? {}) },
    hgetall(key) { return hashes.get(key) ?? null },
    sadd(key, member) { sets.set(key, [...new Set([...(sets.get(key) ?? []), member])]); return 1 },
    smembers(key) { return sets.get(key) ?? [] },
    expire() { return 1 },
    del(...keys) {
      let deleted = 0
      for (const key of keys) deleted += Number(values.delete(key) | hashes.delete(key) | sets.delete(key))
      return deleted
    },
    // The one script lib/turn-credential.ts runs, DROP_LOGIN_CHAT: delete
    // KEYS[2..], and KEYS[1] only while it holds ARGV[1].
    // tests/turn-credential.integration.mjs runs the real Lua against Redis.
    eval(_script, keys, args) {
      const turns = commands.del(...keys.slice(1))
      const latest = args[0] !== '' && values.get(keys[0]) === args[0] ? commands.del(keys[0]) : 0
      return [turns, latest]
    },
  }
  const client = {
    pipeline() {
      const queued = []
      const pipeline = Object.fromEntries(Object.entries(commands).map(([name, run]) =>
        [name, (...args) => { queued.push(() => run(...args)); return pipeline }]))
      pipeline.exec = async () => queued.map((run) => run())
      return pipeline
    },
    ...Object.fromEntries(Object.entries(commands).map(([name, run]) => [name, async (...args) => run(...args)])),
  }
  return { client, values, hashes, sets }
}

let loaded = null

// lib/turn-credential.ts with its Redis client replaced by `store` for this
// test. Keys carry the prefix `test:`.
export async function turnCredentialWith(t, store) {
  globalThis.__memoryRedis = store.client
  t.after(() => { delete globalThis.__memoryRedis })
  loaded ??= (async () => {
    const hook = registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.includes('/lib/turn-credential.ts') && specifier === './journal.ts') {
        const source = 'export const prefixed = key => "test:" + key; export const redis = () => globalThis.__memoryRedis'
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
      }
      return next(specifier, context)
    } })
    try { return await import('../../lib/turn-credential.ts') } finally { hook.deregister() }
  })()
  return loaded
}
