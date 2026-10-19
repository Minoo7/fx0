import assert from 'node:assert/strict'
import test from 'node:test'
import { assertGatewaySession, assertGenerationCredential, bindGatewaySession, gatewayFetch, htmlFieldExtractor, RATE_LIMIT_ATTEMPTS } from '../lib/gateway-session.ts'

const session = (extra = {}) => ({ userId: 'user-a', email: 'a@example.com', name: 'A', isLoggedIn: true,
  loginId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', loginAt: 1_000,
  accessToken: 'user-token-a', refreshToken: 'refresh-never-bound', teamId: 'team_a', expiresAt: Date.now() + 3600_000, ...extra })
const host = () => ({ gatewaySession: null, busy: false, agentStarting: null })

test('an explicit sponsored admission uses the server key without a customer card or OAuth team', async (t) => {
  const previous = { key: process.env.AI_GATEWAY_API_KEY, enabled: process.env.FX0_FREE_PROMPTS }
  process.env.AI_GATEWAY_API_KEY = 'synthetic-trial-key'
  process.env.FX0_FREE_PROMPTS = '1'
  t.after(() => {
    if (previous.key === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous.key
    if (previous.enabled === undefined) delete process.env.FX0_FREE_PROMPTS; else process.env.FX0_FREE_PROMPTS = previous.enabled
  })
  const calls = []
  const runtime = { gatewaySession: { kind: 'trial', userId: 'guest:owner', loginId: 'a'.repeat(32), expiresAt: Date.now() + 3600_000 } }
  const request = gatewayFetch(runtime, async (_url, init) => { calls.push(init); return Response.json({ ok: true }) })
  const body = JSON.stringify({ prompt: [] })
  const modelHeaders = { 'ai-language-model-id': 'anthropic/claude-opus-5.5-fast' }
  assert.equal((await request('https://ai-gateway.vercel.sh/v4/ai/language-model', { method: 'POST', body,
    headers: { ...modelHeaders, authorization: 'Bearer customer-token', 'x-vercel-ai-gateway-team': 'team_customer' } })).status, 200)
  assert.equal(calls[0].headers.get('authorization'), 'Bearer synthetic-trial-key')
  assert.equal(calls[0].headers.has('x-vercel-ai-gateway-team'), false)
  await assert.rejects(request('https://ai-gateway.vercel.sh/v4/ai/language-model', { method: 'POST', body, headers: { 'ai-language-model-id': 'other/model' } }), /free prompts.*Opus/i)
  await assert.rejects(request('https://ai-gateway.vercel.sh/v1/credits'), /free prompts/i)
  process.env.FX0_FREE_PROMPTS = '0'
  await assert.rejects(request('https://ai-gateway.vercel.sh/v4/ai/language-model', { method: 'POST', body, headers: modelHeaders }), /unavailable/i)
  assert.equal(calls.length, 1)
})

test('normal inference adds current user credentials with exactly one request and no database/auth/credits lookup', async () => {
  const runtime = host()
  const credential = session()
  bindGatewaySession(runtime, credential)
  assert.equal('refreshToken' in runtime.gatewaySession, false)
  assertGenerationCredential(runtime)
  const calls = []
  const request = gatewayFetch(runtime, async (url, options) => { calls.push([url, options]); return Response.json({ ok: true }) })
  await request('https://ai-gateway.vercel.sh/coding-agent/v1/agent', { method: 'POST', body: '{}', headers: { authorization: 'Bearer shared-key', 'x-custom': 'kept' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].headers.get('authorization'), 'Bearer user-token-a')
  assert.equal(calls[0][1].headers.get('x-vercel-ai-gateway-team'), 'team_a')
  assert.equal(calls[0][1].headers.get('x-custom'), 'kept')
  assert.equal(calls[0][1].redirect, 'error')
})

test('cached parent and subagent transports read renewed credentials, and reject stale requests and other owners', async () => {
  const runtime = host()
  const first = session()
  bindGatewaySession(runtime, first)
  const tokens = []
  const parent = gatewayFetch(runtime, async (_url, opts) => { tokens.push(opts.headers.get('authorization')); return Response.json({}) })
  const child = gatewayFetch(runtime, async (_url, opts) => { tokens.push(opts.headers.get('authorization')); return Response.json({}) })
  const renewed = session({ accessToken: 'renewed', expiresAt: first.expiresAt + 3600_000 })
  bindGatewaySession(runtime, renewed)
  bindGatewaySession(runtime, first)
  await parent('https://ai-gateway.vercel.sh/v1/chat/completions')
  await child('https://ai-gateway.vercel.sh/v1/chat/completions')
  assert.deepEqual(tokens, ['Bearer renewed', 'Bearer renewed'])
  assert.throws(() => bindGatewaySession(runtime, session({ userId: 'user-b' })), /Session not found/)
  runtime.gatewaySession = null
  await assert.rejects(parent('https://ai-gateway.vercel.sh/v1/chat/completions'), /Sign in required/)
})

test('a team switch on the same login rebinds warm runtimes; another login cannot steer the team', () => {
  const runtime = host()
  bindGatewaySession(runtime, session())
  for (const busy of [false, true]) {
    runtime.busy = busy
    bindGatewaySession(runtime, session({ teamId: 'team_b' }))
    assert.equal(runtime.gatewaySession.teamId, 'team_b')
    bindGatewaySession(runtime, session({ teamId: 'team_c', loginId: 'c'.repeat(32), loginAt: 500 }))
    assert.equal(runtime.gatewaySession.teamId, 'team_b', 'an older login never replaces the bound team')
    bindGatewaySession(runtime, session({ teamId: 'team_a' }))
  }
})

test('a stale login cannot replace a newer same-team grant even with a longer token expiry', () => {
  const runtime = host()
  const older = session({ accessToken: 'old-login', expiresAt: Date.now() + 7200_000 })
  const newer = session({ loginId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', loginAt: 2_000, accessToken: 'new-login' })
  bindGatewaySession(runtime, older)
  bindGatewaySession(runtime, newer)
  bindGatewaySession(runtime, older)
  assert.equal(runtime.gatewaySession.accessToken, 'new-login')
  assert.equal(runtime.gatewaySession.loginId, newer.loginId)
})

test('credentials cannot leave the exact Gateway origin or follow redirects', async () => {
  let calls = 0
  const request = gatewayFetch({ gatewaySession: session() }, async () => { calls++; return Response.json({}) })
  for (const url of ['https://example.com', 'http://ai-gateway.vercel.sh/v1/models', 'https://ai-gateway.vercel.sh.evil.example', 'https://ai-gateway.vercel.sh:444/v1/models', 'https://user:pass@ai-gateway.vercel.sh/v1/models']) {
    await assert.rejects(request(url), /cannot leave/)
  }
  assert.equal(calls, 0)
})

test('Request headers are preserved and expired/missing grants never reach the network', async () => {
  const calls = []
  const request = gatewayFetch({ gatewaySession: session() }, async (url, opts) => { calls.push(opts); return Response.json({}) })
  await request(new Request('https://ai-gateway.vercel.sh/v1/chat/completions', { headers: { 'x-test': 'request-header' } }))
  assert.equal(calls[0].headers.get('x-test'), 'request-header')
  for (const bad of [null, session({ teamId: undefined }), session({ accessToken: '' }), session({ expiresAt: Date.now() - 1 }), session({ expiresAt: NaN })]) {
    assert.throws(() => assertGatewaySession(bad))
  }
  const runtime = host()
  bindGatewaySession(runtime, session({ expiresAt: Date.now() + 14 * 60_000 }))
  assert.throws(() => assertGenerationCredential(runtime), /needs renewal/)
})

test('a long turn keeps using a valid token without imposing the initial 15 minute floor on every tool followup', async () => {
  const request = gatewayFetch({ gatewaySession: session({ expiresAt: Date.now() + 5 * 60_000 }) }, async () => Response.json({ ok: true }))
  assert.equal((await request('https://ai-gateway.vercel.sh/coding-agent/v1/agent')).status, 200)
})

test('provider error bodies cannot leak credentials into transport diagnostics, while backoff survives', async () => {
  const request = gatewayFetch({ gatewaySession: session() }, async () => new Response('credential user-token-a refresh-secret echoed', { status: 429, headers: { 'retry-after': '3', 'x-secret': 'secret' } }))
  const response = await request('https://ai-gateway.vercel.sh/v1/chat/completions')
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '3')
  assert.equal(response.headers.get('x-secret'), null)
  const body = await response.text()
  assert.ok(!body.includes('user-token-a') && !body.includes('refresh-secret'))
})

test('consecutive 429s end the turn with a non-retryable status; any success resets the streak', async () => {
  const runtime = { gatewaySession: session() }
  let status = 429
  const request = gatewayFetch(runtime, async () => new Response(null, { status }))
  for (let attempt = 1; attempt < RATE_LIMIT_ATTEMPTS; attempt++) {
    assert.equal((await request('https://ai-gateway.vercel.sh/v1/chat/completions')).status, 429)
  }
  assert.equal((await request('https://ai-gateway.vercel.sh/v1/chat/completions')).status, 400)
  assert.equal(runtime.rateLimitStreak, RATE_LIMIT_ATTEMPTS)
  status = 200
  assert.equal((await request('https://ai-gateway.vercel.sh/v1/chat/completions')).status, 200)
  assert.equal(runtime.rateLimitStreak, 0)
})

test('public model metadata goes out without credentials; everything else carries them', async () => {
  const calls = []
  const request = gatewayFetch({ gatewaySession: session() }, async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) })
    return Response.json({ data: [] })
  })
  await request('https://ai-gateway.vercel.sh/v1/models')
  await request('https://ai-gateway.vercel.sh/v1/models/anthropic/claude-opus-5.5-fast/endpoints')
  await request('https://ai-gateway.vercel.sh/coding-agent/v1/models')
  await request('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(calls[0].headers.get('authorization'), null)
  assert.equal(calls[1].headers.get('authorization'), null)
  assert.equal(calls[1].headers.get('x-vercel-ai-gateway-team'), null)
  assert.equal(calls[2].headers.get('authorization'), null)
  assert.match(calls[3].headers.get('authorization'), /^Bearer /)
  await assert.rejects(gatewayFetch({ gatewaySession: session() })('https://evil.example/v1/models'), /cannot leave AI Gateway/)
})

test("Gateway's error type and message reach the user scrubbed of credentials", async () => {
  const runtime = { gatewaySession: session() }
  const token = runtime.gatewaySession.accessToken
  const request = gatewayFetch(runtime, async () => Response.json({
    error: { type: 'rate_limit_exceeded', message: `Free tier limit reached for ${token}. Bearer abc.def Add credits to continue.` },
  }, { status: 429 }))
  const response = await request('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'POST', body: '{}' })
  assert.equal(response.status, 429)
  const body = await response.text()
  assert.ok(!body.includes(token))
  assert.match(body, /Free tier limit reached for \[redacted\]\. Bearer \[redacted\] Add credits to continue\./)
  assert.equal(runtime.lastGatewayError.type, 'rate_limit_exceeded')
  assert.ok(!runtime.lastGatewayError.message.includes(token))
})

test('the design draft decodes the streamed html argument across arbitrary delta splits', () => {
  const html = '<!doctype html><p class="a">Hi \\n "there" \u00e9</p>\n<script>if(a<b){}</script>'
  const json = JSON.stringify({ html })
  for (const size of [1, 2, 3, 7, json.length]) {
    let out = ''
    const push = htmlFieldExtractor((chunk) => { out += chunk })
    for (let i = 0; i < json.length; i += size) push(json.slice(i, i + size))
    assert.equal(out, html, `split ${size}`)
  }
})

test('design drafts are observed without changing the bytes libfx gets', async () => {
  const parts = [
    { type: 'tool-input-start', id: 't1', toolName: 'publish_design' },
    { type: 'tool-input-delta', id: 't1', delta: '{"html": "<h1>Hel' },
    { type: 'tool-input-delta', id: 't1', delta: 'lo</h1>"}' },
    { type: 'tool-input-end', id: 't1' },
  ]
  const body = parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('')
  const drafts = []
  const request = gatewayFetch({ gatewaySession: session() }, async () => new Response(body), (id, chunk) => drafts.push([id, chunk]))
  const response = await request('https://ai-gateway.vercel.sh/v4/ai/language-model', { method: 'POST', body: '{}' })
  assert.equal(await response.text(), body)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(drafts.map(([, chunk]) => chunk).join(''), '<h1>Hello</h1>')
  assert.ok(drafts.every(([id]) => id === 't1'))
})

test('argument-end waits for the final draft flush before delivering bytes to libfx', async () => {
  const body=[
    {type:'tool-input-start',id:'call',toolName:'publish_design'},
    {type:'tool-input-delta',id:'call',delta:'{"html":"<body>ready</body>"}'},
    {type:'tool-input-end',id:'call'},
  ].map(part=>`data: ${JSON.stringify(part)}\n\n`).join('')
  let release
  const barrier=new Promise(resolve=>{release=resolve})
  const output=[]
  const request=gatewayFetch({gatewaySession:session()},async()=>new Response(body),{
    delta:(_id,delta)=>output.push(delta),end:()=>barrier,
  })
  const response=await request('https://ai-gateway.vercel.sh/v4/ai/language-model')
  let consumed=false
  const read=response.text().then(text=>{consumed=true;return text})
  await new Promise(setImmediate)
  assert.equal(output.join(''),'<body>ready</body>')
  assert.equal(consumed,false)
  release()
  assert.equal(await read,body)
})

test('cancelling or truncating a model body closes its provisional draft', async () => {
  const body=`data: ${JSON.stringify({type:'tool-input-start',id:'call',toolName:'publish_design'})}\n\n`
  for(const cancel of [false,true]) {
    let aborted=0
    const source=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(body));if(!cancel)c.close()}})
    const request=gatewayFetch({gatewaySession:session()},async()=>new Response(source),{
      delta:()=>{},abort:()=>{aborted++},
    })
    const response=await request('https://ai-gateway.vercel.sh/v4/ai/language-model')
    if(cancel){const reader=response.body.getReader();await reader.read();await reader.cancel()}
    else await response.text()
    assert.equal(aborted,1)
  }
})

const laptop = (extra = {}) => session({ loginId: 'l'.repeat(32), loginAt: 1_000, accessToken: 'laptop', teamId: 'team_laptop', ...extra })
const phone = (extra = {}) => session({ loginId: 'p'.repeat(32), loginAt: 2_000, accessToken: 'phone', teamId: 'team_phone', ...extra })

test('a bound credential that can no longer generate yields to another login of the same user that can', () => {
  const runtime = host()
  bindGatewaySession(runtime, phone({ expiresAt: Date.now() + 60_000 }))
  bindGatewaySession(runtime, laptop())
  assert.equal(runtime.gatewaySession.accessToken, 'laptop', 'the aging newer login no longer locks the chat')
  assertGenerationCredential(runtime)
  bindGatewaySession(runtime, phone({ expiresAt: Date.now() + 60_000 }))
  assert.equal(runtime.gatewaySession.accessToken, 'laptop', 'a usable credential is never replaced by an aging one')
})

test('the prompt submitter\'s credential and team bind, whichever login is older', () => {
  const runtime = host()
  bindGatewaySession(runtime, phone())
  bindGatewaySession(runtime, laptop())
  assert.equal(runtime.gatewaySession.teamId, 'team_phone')
  bindGatewaySession(runtime, laptop(), { submitter: true })
  assert.equal(runtime.gatewaySession.teamId, 'team_laptop')
  assert.throws(() => bindGatewaySession(runtime, session({ userId: 'user-b' }), { submitter: true }), /Session not found/)
})

test('a stale same-login request cannot put back an older token with an older team', () => {
  const runtime = host()
  const stale = laptop({ expiresAt: Date.now() + 3600_000 })
  bindGatewaySession(runtime, laptop({ accessToken: 'renewed', teamId: 'team_new', expiresAt: stale.expiresAt + 3600_000 }))
  bindGatewaySession(runtime, stale)
  assert.equal(runtime.gatewaySession.accessToken, 'renewed')
  assert.equal(runtime.gatewaySession.teamId, 'team_new')
})

