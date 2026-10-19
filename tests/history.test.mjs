import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHistoryStore } from '../lib/history.ts'

const sessionId = 'a4b0d934-8e2a-4c19-924e-18a491b16767'
const turn = {
  sessionId, turnId: 3, prompt: 'Design a pricing page for a coffee subscription service', response: 'Done.',
  model: 'anthropic/claude-opus-5.5-fast', effort: 'low', fast: true, status: 'done', stopReason: 'end_turn', billingTeamId: 'team_a',
  inputTokens: 1200, outputTokens: 800, startedAt: 1_759_330_000_000,
}

function recorder(rows = [{ ok: 1 }]) {
  const calls = []
  return { calls, store: createHistoryStore(async (text, values = []) => { calls.push({ text, values }); return rows }) }
}

test('a turn is stored through the chat row, titling the chat once', async () => {
  const { calls, store } = recorder()
  assert.equal(await store.recordTurn(turn), true)
  const [{ text, values }] = calls
  assert.match(text, /UPDATE fx0_chat_ownership SET title = COALESCE\(title, \$13\)/)
  assert.match(text, /ON CONFLICT \(session_id, turn_id\) DO NOTHING/)
  assert.equal(values[0], sessionId)
  assert.equal(values[2], turn.prompt)
  assert.equal(values[12], turn.prompt.slice(0, 40))
  assert.equal(values[13], 'team_a')
})

test('a finished turn or a new design keeps the chat\'s place in the sidebar', async () => {
  const { calls, store } = recorder()
  await store.recordTurn(turn)
  await store.recordGeneration(sessionId, 2, 3, '<!doctype html>')
  assert.equal(calls.length, 2)
  for (const { text } of calls) assert.doesNotMatch(text, /updated_at/)
})

test('a turn or generation for an unowned chat records nothing', async () => {
  const { store } = recorder([])
  assert.equal(await store.recordTurn(turn), false)
  assert.equal(await store.recordGeneration(sessionId, 2, 3, '<!doctype html>'), false)
})

test('invalid IDs and revisions never reach the database', async () => {
  const { calls, store } = recorder()
  assert.equal(await store.recordTurn({ ...turn, sessionId: '../other' }), false)
  assert.equal(await store.recordTurn({ ...turn, turnId: 0 }), false)
  assert.equal(await store.recordGeneration(sessionId, 1.5, null, 'x'), false)
  assert.equal(await store.readGeneration('user_a', 'NOT VALID', 1), null)
  assert.equal(await store.readGeneration('user_a', sessionId, -1), null)
  assert.equal(calls.length, 0)
})

test('generations store their byte size and drop invalid token counts', async () => {
  const { calls, store } = recorder()
  await store.recordGeneration(sessionId, 2, null, 'héllo')
  assert.equal(calls[0].values[4], 6)
  await store.recordTurn({ ...turn, inputTokens: -1, outputTokens: Number.NaN })
  assert.deepEqual(calls[1].values.slice(9, 11), [null, null])
})

test('version reads are scoped to the owner', async () => {
  const { calls, store } = recorder([{ html: '<!doctype html>' }])
  assert.equal(await store.readGeneration('user_a', sessionId, 2), '<!doctype html>')
  assert.match(calls[0].text, /c\.user_id = \$3/)
  assert.deepEqual(calls[0].values, [sessionId, 2, 'user_a'])
})

test('history tables cascade from the chat row', async () => {
  const migration = await readFile(new URL('../migrations/002_history.sql', import.meta.url), 'utf8')
  assert.equal(migration.match(/REFERENCES fx0_chat_ownership\(session_id\) ON DELETE CASCADE/g)?.length, 2)
})
