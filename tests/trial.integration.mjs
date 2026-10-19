import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { registerHooks } from 'node:module'

const run = promisify(execFile)
const trial = await import('../lib/trial.ts').catch(() => ({}))

test('five free admissions are shared across chats and cannot be exceeded concurrently', async (t) => {
  assert.equal(typeof trial.createTrialStore, 'function', 'the five-prompt allowance is missing')
  const dir = await mkdtemp(join(tmpdir(), 'fx0-trial-'))
  const socket = join(dir, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  t.after(async () => { server.kill(); await new Promise(resolve => server.once('exit', resolve)); await rm(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100; i++) {
    try { await run('redis-cli', ['-s', socket, 'PING']); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  const evalClient = {
    async eval(script, keys, args) {
      const { stdout } = await run('redis-cli', ['-s', socket, '--json', 'EVAL', script, String(keys.length), ...keys, ...args.map(String)])
      return JSON.parse(stdout)
    },
  }
  const store = trial.createTrialStore(evalClient, 'trial-test')
  const attempts = await Promise.all(Array.from({ length: 20 }, (_, i) => store.reserve('ip-hash-a', `message-${i}`)))
  const admitted = attempts.filter(Boolean)
  assert.equal(admitted.length, 5)
  assert.deepEqual(admitted.map(x => x.remaining).sort(), [0, 1, 2, 3, 4])
  assert.equal(await store.reserve('ip-hash-a', 'sixth-chat'), null)
  assert.equal((await store.reserve('ip-hash-b', 'message-0')).remaining, 4, 'another IP has its own allowance')
  await assert.rejects(store.reserve('ip-hash-a', admitted[0].clientId), /already submitted/i)
  await store.release(admitted[0])
  await store.release(admitted[0])
  const replacement = await store.reserve('ip-hash-a', 'replacement')
  assert.equal(replacement.remaining, 0, 'a failed admission releases exactly one slot')
  await store.commit(replacement)
  await store.release(replacement)
  assert.equal(await store.reserve('ip-hash-a', 'after-commit'), null, 'an accepted prompt cannot be refunded')

  // Drive the actual journal Lua against Redis too. The first admission pins
  // whether a chat may ever contain sponsored turns, before any SDK call.
  globalThis.localTrialRedis = evalClient
  const hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@upstash/redis' && context.parentURL?.includes('trial-admission')) {
      return { url: `data:text/javascript,${encodeURIComponent('export class Redis { constructor() { return globalThis.localTrialRedis } }')}`, shortCircuit: true }
    }
    return next(specifier, context)
  } })
  const previous = { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN, prefix: process.env.FX0_REDIS_PREFIX }
  Object.assign(process.env, { KV_REST_API_URL: 'https://local-test.invalid', KV_REST_API_TOKEN: 'synthetic', FX0_REDIS_PREFIX: 'fx0:trial-integration' })
  t.after(() => {
    hook.deregister(); delete globalThis.localTrialRedis
    for (const [key, value] of Object.entries({ KV_REST_API_URL: previous.url, KV_REST_API_TOKEN: previous.token, FX0_REDIS_PREFIX: previous.prefix })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  const journal = await import('../lib/journal.ts?trial-admission')
  const prompt = { author: 'You', text: 'Hello' }
  assert.equal((await journal.submitPrompt('free-chat', prompt, undefined, true)).trialChat, true)
  assert.equal((await journal.submitPrompt('free-chat', prompt, undefined, false)).trialChat, true, 'paid continuation stays a separate turn')
  assert.equal((await journal.submitPrompt('paid-chat', prompt)).trialChat, false)
  await assert.rejects(journal.submitPrompt('paid-chat', prompt, undefined, true), /new design/)
  const { stdout: count } = await run('redis-cli', ['-s', socket, 'GET', 'fx0:trial-integration:session:paid-chat:message-seq'])
  assert.equal(count.trim(), '1', 'rejected funding transitions cannot append a user event')
})
