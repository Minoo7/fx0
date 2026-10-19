import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { memoryRedis, turnCredentialWith } from './fixtures/memory-redis.mjs'

// Sign-out's Lua against a throwaway local Redis: the unit tests stand in for
// it in memory, this checks the script itself.
const run = promisify(execFile)

test('sign-out deletes the latest credential only while it holds the value it read', async (t) => {
  const { DROP_LOGIN_CHAT } = await turnCredentialWith(t, memoryRedis())
  const dir = await mkdtemp(join(tmpdir(), 'fx0-credential-'))
  const socket = join(dir, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
  t.after(async () => { server.kill(); await new Promise(resolve => server.once('exit', resolve)); await rm(dir, { recursive: true, force: true }) })
  for (let i = 0; i < 100; i++) {
    try { await run('redis-cli', ['-s', socket, 'PING']); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  const redis = async (...args) => JSON.parse((await run('redis-cli', ['-s', socket, '--json', ...args])).stdout)
  const drop = (keys, seal) => redis('EVAL', DROP_LOGIN_CHAT, String(keys.length), ...keys, seal)

  await redis('SET', 'latest', 'Fe26.2**laptop')
  await redis('SET', 'turn:1', 'Fe26.2**laptop-1')
  await redis('SET', 'turn:3', 'Fe26.2**laptop-3')
  assert.deepEqual(await drop(['latest', 'turn:1', 'turn:3', 'turn:9'], 'Fe26.2**laptop'), [2, 1])
  assert.equal(await redis('EXISTS', 'latest', 'turn:1', 'turn:3'), 0)

  // Another login stored the chat's latest credential after sign-out read it.
  await redis('SET', 'latest', 'Fe26.2**phone')
  await redis('SET', 'turn:4', 'Fe26.2**laptop-4')
  assert.deepEqual(await drop(['latest', 'turn:4'], 'Fe26.2**laptop'), [1, 0])
  assert.equal(await redis('GET', 'latest'), 'Fe26.2**phone')

  // The latest credential was never this login's.
  assert.deepEqual(await drop(['latest'], ''), [0, 0])
  assert.equal(await redis('GET', 'latest'), 'Fe26.2**phone')
})
