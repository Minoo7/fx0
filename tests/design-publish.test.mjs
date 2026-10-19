import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// publishDesignArtifact makes one Redis call, recorded here: its first argument is
// the design that gets stored.
const stored = []
globalThis.__designPublishCalls = stored
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@upstash/redis' && context.parentURL?.endsWith('/lib/journal.ts')) {
      const fake = 'export class Redis { async eval(script, keys, args) { globalThis.__designPublishCalls.push(args[0]); return { status: "published", revision: 1 } } }'
      return { url: `data:text/javascript,${encodeURIComponent(fake)}`, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
process.env.KV_REST_API_URL ??= 'https://redis.invalid'
process.env.KV_REST_API_TOKEN ??= 'test-token'
const { publishDesignArtifact } = await import('../lib/journal.ts')

const DESIGN = '<!doctype html><html><head></head><body><p>design</p></body></html>'

test('publishing stores the normalized design that passed validation, never the raw input', async () => {
  const raw = `\u00a0\ufeff<!DOCTYPE\u00a0html>${DESIGN.slice('<!doctype html>'.length)}\n\u3000`
  assert.deepEqual(await publishDesignArtifact('chat', raw, 4), { ok: true, revision: 1, changed: true, event: undefined })
  assert.deepEqual(stored, [DESIGN])

  // An invisible character that is not whitespace is spelled out for the model, and nothing is stored.
  assert.deepEqual(await publishDesignArtifact('chat', `\u200b${DESIGN}`), {
    ok: false,
    reason: 'invalid',
    error: 'design artifact must start with <!doctype html>, but it starts with "\\u200b<!doctype html><html><h…"',
  })
  assert.deepEqual(stored, [DESIGN])
})
