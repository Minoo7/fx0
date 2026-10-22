import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const base = 'http://127.0.0.1:3000'
const secret = await readFile('/secrets/proxy', 'utf8')
const headers = {
  origin: 'https://127.0.0.1:3000',
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
const catalog = await models.json()
const providers = await fetch(`${base}/api/providers`, { headers })
assert.equal(providers.status, 200)
const providerList = (await providers.json()).providers
assert(providerList.length > 10)
const connected = new Set(providerList.filter(provider => provider.configured).map(provider => provider.id))
assert(catalog.models.every(model => connected.has(model.split('/')[0])))
assert(catalog.defaultModel === '' || catalog.models.includes(catalog.defaultModel))
const create = await fetch(`${base}/api/sessions`, { method: 'POST', headers, body: '{}' })
assert.equal(create.status, 201, await create.clone().text())
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

const proxy = spawn(process.execPath, ['scripts/tailnet-proxy.mjs'], {
  env: { ...process.env, FX0_PROXY_PORT: '3001', FX0_UPSTREAM: base }, stdio: 'inherit',
})
try {
  let listening = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try { listening = (await fetch('http://127.0.0.1:3001', { signal: AbortSignal.timeout(1000) })).status === 403 } catch {}
    if (listening) break
    await setTimeout(100)
  }
  assert(listening, 'identity proxy must start and deny unauthenticated access')
  const authenticatedUrl = `http://127.0.0.1:3001/api/auth/me?fx0_proxy_key=${secret}`
  for (const [url, untrusted] of [
    ['http://127.0.0.1:3001/api/auth/me', { 'x-tsdproxy-username': 'spoof@example.invalid' }],
    [authenticatedUrl, {}],
  ]) {
    assert.equal((await fetch(url, { headers: untrusted })).status, 403)
  }
  const identity = await fetch(authenticatedUrl, { headers: {
    'x-tsdproxy-username': 'ci@example.invalid',
    'tailscale-user-login': 'spoof@example.invalid',
  } })
  assert.equal(identity.status, 200)
  assert.equal((await identity.json()).user.email, 'ci@example.invalid')
  console.log('Real identity proxy authentication and spoofed-header rejection passed')
} finally {
  const exited = once(proxy, 'exit')
  proxy.kill('SIGTERM')
  await exited
}
