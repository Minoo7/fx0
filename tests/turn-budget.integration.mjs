import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

// The turn step budget's real Lua on a local redis-server; no remote services.
const run = promisify(execFile)
const { createTurnBudget } = await import('../lib/turn-budget.ts')

test('a turn counts each step once across its parent and subagents, even when they run at once', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fx0-turn-budget-'))
  const socket = join(dir, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  t.after(async () => { server.kill(); await new Promise(resolve => server.once('exit', resolve)); await rm(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100; i++) {
    try { await run('redis-cli', ['-s', socket, 'PING']); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  const redisCli = (...args) => run('redis-cli', ['-s', socket, ...args.map(String)])
  const evalClient = {
    async eval(script, keys, args) {
      const { stdout } = await redisCli('--json', 'EVAL', script, keys.length, ...keys, ...args)
      return JSON.parse(stdout)
    },
  }
  const budget = createTurnBudget(evalClient, 'budget-test')

  // 70 different steps at once, from the parent and two subagents: each gets its own count.
  const names = Array.from({ length: 70 }, (_, i) => `${['parent', 'subagent:a', 'subagent:b'][i % 3]}:step-${i}`)
  const counts = await Promise.all(names.map((name) => budget.reserve('chat', 7, name)))
  assert.deepEqual([...counts].sort((a, b) => a - b), Array.from({ length: 70 }, (_, i) => i + 1))

  // Resending a step, even many at once, never raises the count.
  const resent = await Promise.all(Array.from({ length: 10 }, () => budget.reserve('chat', 7, names[0])))
  assert.deepEqual(resent, Array(10).fill(70))

  // Another turn, or another chat, has its own budget.
  assert.equal(await budget.reserve('chat', 8, names[0]), 1)
  assert.equal(await budget.reserve('other-chat', 7, names[0]), 1)

  // The count outlives any turn, then expires.
  const ttl = Number((await redisCli('TTL', 'budget-test:chat:7')).stdout)
  assert.ok(ttl > 86_000 && ttl <= 86_400, `ttl ${ttl}`)
})
