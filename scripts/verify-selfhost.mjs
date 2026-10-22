import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const base = 'http://127.0.0.1:3000'
const secret = await readFile('/secrets/proxy', 'utf8')
const headers = {
  host: 'fx0.example.invalid', origin: 'https://fx0.example.invalid',
  'x-fx0-proxy-secret': secret, 'tailscale-user-login': 'ci@example.invalid',
  'content-type': 'application/json',
}
let ready = false
for (let attempt = 0; attempt < 30; attempt++) {
  try { ready = (await fetch(base, { signal: AbortSignal.timeout(2000) })).status === 403 } catch {}
  if (ready) break
  await setTimeout(1000)
}
assert(ready, 'app must start and deny untrusted access')
const models = await fetch(`${base}/api/models`, { headers })
assert.equal(models.status, 200)
assert((await models.json()).models.length > 100)
const providers = await fetch(`${base}/api/providers`, { headers })
assert.equal(providers.status, 200)
assert((await providers.json()).providers.length > 10)
const create = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: '{}' })
assert.equal(create.status, 201)
const { sessionId } = await create.json()
try {
  const owned = await fetch(`${base}/api/session?session=${sessionId}`, { headers })
  assert.equal(owned.status, 200)
  const other = await fetch(`${base}/api/session?session=${sessionId}`, {
    headers: { ...headers, 'tailscale-user-login': 'other-ci@example.invalid' },
  })
  assert.equal(other.status, 404)
  const crossOrigin = await fetch(`${base}/api/sessions`, {
    method: 'POST', headers: { ...headers, origin: 'https://other.example.invalid' }, body: '{}',
  })
  assert.equal(crossOrigin.status, 403)
} finally {
  const remove = await fetch(`${base}/api/session?session=${sessionId}`, { method: 'DELETE', headers })
  assert.equal(remove.status, 200)
}
console.log('Real Compose startup, Pi catalog, chat lifecycle, ownership and origin checks passed')
