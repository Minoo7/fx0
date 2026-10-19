import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { sealData, unsealData } from 'iron-session'

const functions = JSON.parse(await readFile('.next/server/functions-config-manifest.json', 'utf8'))
const middleware = JSON.parse(await readFile('.next/server/middleware-manifest.json', 'utf8'))
assert.ok(!('/_middleware' in functions.functions), 'the production build must not deploy a separate proxy function')
assert.deepEqual(middleware.middleware, {}, 'page and API requests must not pass through middleware')

// Runs the actual production build, including Next's proxied route requests.
// OAuth and Redis use an in-memory fetch boundary; no remote services are called.
const probe = createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))
const origin = 'https://fx0-local-smoke.example'
const base = `http://127.0.0.1:${port}`
const secret = randomBytes(32).toString('base64')
const env = { ...process.env, NODE_ENV: 'production', APP_URL: origin, SESSION_SECRET: secret,
  VERCEL_OAUTH_CLIENT_ID: 'synthetic-local-client', VERCEL_OAUTH_CLIENT_SECRET: 'synthetic-local-secret',
  KV_REST_API_URL: 'https://auth-smoke-redis.invalid', KV_REST_API_TOKEN: 'synthetic-redis-token',
  FX0_REDIS_PREFIX: 'fx0:auth-smoke', FX0_FREE_PROMPTS: '0', FX0_SMOKE_HOLD_SIGNOUT: '1' }
delete env.DATABASE_URL
delete env.AI_GATEWAY_API_KEY
const child = spawn(process.execPath, ['--import', new URL('./fixtures/auth-smoke-network.mjs', import.meta.url).href,
  'node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
const signoutHeld = Promise.withResolvers()
child.on('message', message => {
  if (message?.kind === 'signout-held') signoutHeld.resolve()
})
let output = ''
let stderr = ''
child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-32_768) })
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32_768) })
const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
async function request(path, options = {}) { return fetch(`${base}${path}`, { ...options, redirect: 'manual' }) }
async function grantCookie(extra = {}) {
  const loginId = randomBytes(16).toString('hex')
  const user = { loginId, loginAt: Date.now(), userId: 'synthetic-smoke-user', name: 'Local Smoke User', email: 'smoke@example.com',
    accessToken: 'synthetic-never-dispatched-access-token', refreshToken: 'synthetic-never-exchanged-refresh-token',
    expiresAt: Date.now() + 3600_000, teamId: 'team_synthetic', isLoggedIn: true, ...extra }
  const grant = await sealData(user, { password: secret, ttl: 90 * 24 * 3600 })
  return { user, grant, cookie: `vercel_auth_session=${loginId}; vercel_auth_grant_${loginId}=${grant}` }
}
try {
  const deadline = Date.now() + 30_000
  let started = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Production server exited during startup')
    try { started = (await request('/api/auth/me')).ok } catch {}
    if (started) break
    await sleep(100)
  }
  assert.ok(started, 'production server must start')
  const landing = await request('/', { headers: { accept: 'text/html' } })
  assert.equal(landing.status, 200, 'guests get the full app')
  const login = await request('/login')
  assert.equal(login.status, 200)
  assert.match(await login.text(), /Continue with Vercel/)

  // Every chat, team and billing route requires a session before any external effect.
  const gets = ['artifact', 'artifact-frame', 'credits', 'debug', 'events', 'model', 'session', 'sessions', 'teams']
  const posts = ['answer', 'cancel', 'model', 'prompt', 'sessions', 'teams', 'warm']
  for (const [method, names] of [['GET', gets], ['POST', posts]]) {
    for (const name of names) {
      const response = await request(`/api/${name}?session=foreign`, { method, headers: { origin }, ...(method === 'POST' ? { body: '{}' } : {}) })
      assert.equal(response.status, 401, `${method} ${name} requires auth before external effects`)
    }
  }

  const { user, grant, cookie } = await grantCookie()
  const profile = await request('/api/auth/me', { headers: { cookie } })
  assert.equal(profile.status, 200)
  const body = await profile.json()
  assert.equal(body.user.id, user.userId)
  assert.equal(body.user.name, user.name)
  assert.ok(!JSON.stringify(body).includes('token'))

  // These cookie rewrites used to clone Next's Proxy as a native Request and
  // throw before the handler ran, even though unproxied module tests passed.
  const obsolete = `vercel_auth_grant_${'a'.repeat(32)}`
  const cleanupCookie = `${cookie}; ${obsolete}=obsolete`
  const cleaned = await request('/api/auth/me', { headers: { cookie: cleanupCookie } })
  assert.equal(cleaned.status, 200, 'grant cleanup must still dispatch the profile handler')
  assert.equal((await cleaned.json()).user.id, user.userId)
  assert.ok(cleaned.headers.getSetCookie().some((value) => value.startsWith(`${obsolete}=`) && value.includes('Max-Age=0')))
  const orphan = await request('/api/auth/me', { headers: { cookie: `${obsolete}=orphan` } })
  assert.equal(orphan.status, 200)
  assert.deepEqual(await orphan.json(), { user: null })
  assert.ok(orphan.headers.getSetCookie().some((value) => value.startsWith(`${obsolete}=`) && value.includes('Max-Age=0')))

  for (const [label, expiresAt] of [['expiring', Date.now() + 60_000], ['expired', Date.now() - 60_000]]) {
    const renewal = await grantCookie({ expiresAt, refreshToken: `synthetic-success-${label}` })
    const renewed = await request('/api/auth/me', { headers: { cookie: renewal.cookie } })
    assert.equal(renewed.status, 200, `${label} grant must renew and dispatch in the same request`)
    assert.equal((await renewed.json()).user.id, renewal.user.userId)
    const cookies = renewed.headers.getSetCookie()
    assert.equal(cookies.length, 1, 'renewal must not rewrite the login selector')
    assert.ok(cookies[0].startsWith(`vercel_auth_grant_${renewal.user.loginId}=`))
    const sealed = cookies[0].split(';')[0].split('=').slice(1).join('=')
    const current = await unsealData(sealed, { password: secret, ttl: 90 * 24 * 3600 })
    assert.equal(current.accessToken, 'synthetic-rotated-access')
    assert.equal(current.refreshToken, 'synthetic-rotated-refresh')
    assert.equal(current.loginId, renewal.user.loginId)
    assert.equal(current.teamId, renewal.user.teamId)
    assert.ok(current.expiresAt > Date.now() + 50 * 60_000)
  }
  const terminal = await grantCookie({ expiresAt: Date.now() + 60_000, refreshToken: 'synthetic-terminal-refresh' })
  const rejected = await request('/api/auth/me', { headers: { cookie: terminal.cookie } })
  assert.equal(rejected.status, 200)
  assert.deepEqual(await rejected.json(), { user: null })
  assert.ok(rejected.headers.getSetCookie().some((value) => value.startsWith(`vercel_auth_grant_${terminal.user.loginId}=`) && value.includes('Max-Age=0')))
  const cleanupCrossOrigin = await request('/api/prompt?session=foreign', {
    method: 'POST', headers: { cookie: cleanupCookie, origin: 'https://other.example' }, body: '{}',
  })
  assert.equal(cleanupCrossOrigin.status, 403, 'cookie rewriting must preserve the mutation method and Origin check')

  const corrupt = await request('/api/auth/me', { headers: { cookie: cookie.replace(grant, 'tampered') } })
  assert.deepEqual(await corrupt.json(), { user: null })
  const malformed = await request('/api/session?session=../../foreign', { headers: { cookie } })
  assert.equal(malformed.status, 404)
  const crossOrigin = await request('/api/prompt?session=foreign', { method: 'POST', headers: { cookie, origin: 'https://other.example' }, body: '{}' })
  assert.equal(crossOrigin.status, 403)
  const retired = await request('/api/reap-drafts', { headers: { cookie } })
  assert.equal(retired.status, 404, 'Sandbox draft reaping is gone')

  // A transient renewal failure never loops: the login page renders and APIs
  // answer 503 with Retry-After. Page loads never renew (auth.test.mjs).
  const expired = await grantCookie({ expiresAt: Date.now() - 60_000 })
  const loginExpired = await request('/login?error=session_unavailable', { headers: { cookie: expired.cookie } })
  assert.equal(loginExpired.status, 200)
  assert.match(await loginExpired.text(), /could not be renewed/)
  const loginPlain = await request('/login', { headers: { cookie: expired.cookie } })
  assert.equal(loginPlain.status, 200, 'an expired grant does not bounce /login back to /')
  const api = await request('/api/sessions', { headers: { cookie: expired.cookie } })
  assert.equal(api.status, 503)
  assert.equal(api.headers.get('retry-after'), '5')

  const signin = await request('/api/auth/signin')
  assert.equal(signin.status, 307)
  const target = new URL(signin.headers.get('location'))
  assert.equal(target.origin, 'https://vercel.com')
  assert.equal(target.searchParams.get('redirect_uri'), `${origin}/api/auth/callback`)
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(signin.headers.get('set-cookie').includes('vercel_oauth_flow'))

  // Reproduce clicking logout and immediately refreshing with the old sealed
  // grant. Hold the real route at Redis, so the refresh cannot pass by luck.
  const leaving = await grantCookie({ expiresAt: Date.now() + 60_000 })
  const pendingCookies = `${leaving.cookie}; fx0-signout-pending=1`
  let completed = false
  const logout = request('/api/auth/signout', {
    method: 'POST', headers: { origin, cookie: pendingCookies },
  }).then(response => { completed = true; return response })
  await Promise.race([signoutHeld.promise, sleep(10_000).then(() => { throw new Error('Logout did not reach the revocation gate') })])
  assert.equal(completed, false)
  const duringLogout = await request('/?s=private-chat', { headers: { cookie: pendingCookies, accept: 'text/html' } })
  assert.equal(duringLogout.status, 200)
  const html = await duringLogout.text()
  assert.ok(!html.includes(leaving.user.name), 'the first refresh must not serialize the old name')
  assert.ok(!html.includes(leaving.user.userId), 'the first refresh must not serialize the old account')
  assert.match(html, /Sign in/)
  const pendingProfile = await request('/api/auth/me', { headers: { cookie: pendingCookies } })
  assert.deepEqual(await pendingProfile.json(), { user: null })
  assert.deepEqual(pendingProfile.headers.getSetCookie(), [], 'pending logout must not renew an expiring grant')
  assert.equal((await request('/api/sessions', { headers: { cookie: pendingCookies } })).status, 401)
  assert.equal(completed, false, 'guest rendering must finish while logout is still blocked')
  child.send({ kind: 'release-signout' })
  const finished = await logout
  assert.equal(finished.status, 200)
  for (const name of ['vercel_auth_session', `vercel_auth_grant_${leaving.user.loginId}`, 'fx0-signout-pending']) {
    assert.ok(finished.headers.getSetCookie().some(value => value.startsWith(`${name}=`) && value.includes('Max-Age=0')), `${name} must clear together`)
  }
  const afterLogout = await request('/')
  assert.equal(afterLogout.status, 200)
  assert.ok(!(await afterLogout.text()).includes(leaving.user.name), 'later refreshes must stay signed out')
  // Signout without a grant checks local clearing only, never Vercel revocation.
  const signout = await request('/api/auth/signout', { method: 'POST', headers: { origin } })
  assert.equal(signout.status, 200)
  assert.ok(signout.headers.get('set-cookie').includes('vercel_auth_session='))
  // Only structured auth diagnostics (no stack traces, no credentials) reach stderr.
  for (const line of stderr.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line)
    assert.match(entry.event, /^auth:/, line)
    assert.ok(!line.includes('synthetic-never'), 'no credential reaches the log')
  }
  console.log('Production auth smoke passed: guest app, login UI, protected APIs, encrypted profile, grant cleanup, successful/terminal/transient renewal, tamper/origin checks, retired Sandbox route, PKCE initiation, signout with a concurrent refresh held at Redis. No remote credentials/services used.')
} finally {
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(5_000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await exited
  }
}
