import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { redisRest } from './fixtures/redis-rest.mjs'

// The journal's turn bookkeeping, Lua included, against a local redis-server behind a
// stand-in for Upstash's REST API. No remote services.
const run = promisify(execFile)
const dir = await mkdtemp(join(tmpdir(), 'fx0-turn-work-'))
const socket = join(dir, 'redis.sock')
const server = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' })
for (let i = 0; i < 100; i++) {
  try { await run('redis-cli', ['-s', socket, 'PING']); break } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
}
const rest = await redisRest(socket)
process.env.KV_REST_API_URL = rest.url
process.env.KV_REST_API_TOKEN = 'local-test-token'
process.env.FX0_REDIS_PREFIX = 'turn-work-test'
const journal = await import('../lib/journal.ts')
test.after(async () => {
  await rest.close()
  server.kill()
  await new Promise(resolve => server.once('exit', resolve))
  await rm(dir, { recursive: true, force: true })
})

const design = (text) => `<!doctype html><html><head></head><body><p>${text}</p></body></html>`
const start = (id, prompt) => ({ id, startedAt: 1_000 + id, billingTeamId: 'team_a', prompt, settings: { model: 'test/model', effort: 'low', fast: true } })
const ended = (id) => ({ type: 'done', id, turnId: id, stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 }, at: 2_000 + id })

test('a turn is marked running with its start, and its end leaves its history and design in the same commit', async () => {
  const chat = 'chat-commit'
  const [started] = await journal.projectEvents(chat, 0, 1, [{ type: 'turn_start', id: 7, turnId: 7, at: 1 }], { 7: start(7, 'Make it teal') })
  assert.deepEqual(await journal.getActiveTurn(chat), { ...start(7, 'Make it teal'), startSeq: started.seq })
  // A second projector still at the old cursor changes nothing.
  assert.equal(await journal.projectEvents(chat, 0, 1, [{ type: 'turn_start', id: 7, turnId: 7, at: 1 }], { 7: start(7, 'other') }), null)
  assert.equal((await journal.getActiveTurn(chat)).prompt, 'Make it teal')

  assert.equal((await journal.publishDesignArtifact(chat, design('teal'), 7)).revision, 1)
  await journal.projectEvents(chat, 1, 2, [ended(7)])
  assert.equal(await journal.getActiveTurn(chat), null)
  const [work] = await journal.readTurnWork(chat)
  assert.deepEqual(work, {
    turnId: 7, type: 'done', stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 }, at: 2_007,
    turn: { ...start(7, 'Make it teal'), startSeq: started.seq },
    design: { revision: 1, html: design('teal') },
  })
  // That design is the turn's history version now: a later turn replacing it keeps no second copy.
  await journal.publishDesignArtifact(chat, design('coral'), 8)
  assert.deepEqual((await journal.readTurnWork(chat)).map((item) => [item.turnId, item.design?.html]), [[7, design('teal')]])

  await journal.finishTurnWork(chat, 7)
  assert.deepEqual(await journal.readTurnWork(chat), [])
})

test('a turn keeps the design it left when the next turn replaces it before its end is projected', async () => {
  const chat = 'chat-lag'
  await journal.projectEvents(chat, 0, 1, [{ type: 'turn_start', id: 1, turnId: 1, at: 1 }], { 1: start(1, 'first') })
  await journal.publishDesignArtifact(chat, design('first'), 1)
  await journal.publishDesignArtifact(chat, design('first, edited'), 1)
  // libfx runs the next turn before the projector reaches the first one's end.
  await journal.publishDesignArtifact(chat, design('second'), 2)
  await journal.projectEvents(chat, 1, 2, [ended(1)])
  const [work] = await journal.readTurnWork(chat)
  assert.equal(work.turnId, 1)
  assert.deepEqual(work.design, { revision: 2, html: design('first, edited') })
})

test('several turns in one batch each get their bookkeeping, in order', async () => {
  const chat = 'chat-batch'
  await journal.projectEvents(chat, 0, 3, [
    { type: 'turn_start', id: 4, turnId: 4, at: 1 }, ended(4), { type: 'turn_start', id: 5, turnId: 5, at: 3 },
  ], { 4: start(4, 'four'), 5: start(5, 'five') })
  assert.equal((await journal.getActiveTurn(chat)).id, 5)
  assert.deepEqual((await journal.readTurnWork(chat)).map((item) => [item.turnId, item.turn?.prompt]), [[4, 'four']])
  // An end whose start was never recorded still leaves its work, without a running record.
  await journal.projectEvents(chat, 3, 4, [ended(6)])
  assert.deepEqual((await journal.readTurnWork(chat)).map((item) => [item.turnId, item.turn?.id ?? null]), [[4, 4], [6, null]])
  assert.equal((await journal.getActiveTurn(chat)).id, 5, 'another turn\'s end leaves the running one alone')
})

test('deleting a chat removes its waiting history work and designs', async () => {
  const chat = 'chat-deleted'
  await journal.projectEvents(chat, 0, 2, [{ type: 'turn_start', id: 1, turnId: 1, at: 1 }, ended(1)], { 1: start(1, 'gone') })
  await journal.publishDesignArtifact(chat, design('kept for turn 1'), 1)
  await journal.publishDesignArtifact(chat, design('turn 2'), 2)
  assert.equal((await journal.readTurnWork(chat)).length, 1)
  assert.equal(await journal.claimSessionCleanup(chat, 'token'), 'claimed')
  assert.equal(await journal.finishSessionCleanup(chat, 'token', null), true)
  assert.deepEqual(await journal.readTurnWork(chat), [])
})
