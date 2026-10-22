import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { reserveSession, assertSessionOwner, removeOwnedSession, ownedSessionIds } from '../lib/accounts.ts'
import { tailnetSession, assertSameOrigin } from '../lib/tailnet-auth.ts'
import { fileAssets } from '../lib/file-assets.ts'
import { piContext, piReplayMetadata } from '../lib/pi-context.ts'
import { piModels, modelId, findModel } from '../lib/pi-models.ts'

test('tailnet identity requires the private proxy and mutations require same origin', () => {
  process.env.FX0_PROXY_SECRET = randomUUID()
  const headers = new Headers({ 'tailscale-user-login': 'fixture@example.invalid' })
  expect(() => tailnetSession(headers)).toThrow()
  headers.set('x-fx0-proxy-secret', process.env.FX0_PROXY_SECRET)
  expect(tailnetSession(headers).userId).toStartWith('tailscale:')
  headers.delete('tailscale-user-login')
  expect(() => tailnetSession(headers)).toThrow()
  process.env.APP_URL = 'https://fx0.example.invalid'
  expect(() => assertSameOrigin(new Request('https://fx0.example.invalid/api/prompt', {
    headers: { origin: 'https://other.example.invalid' },
  }))).toThrow()
  assertSameOrigin(new Request('https://fx0.example.invalid/api/prompt', {
    headers: { origin: process.env.APP_URL },
  }))
})

test('all Pi chat models roundtrip through the fx0 model identifier', () => {
  const models = piModels.getModels()
  expect(models.length).toBeGreaterThan(100)
  for (const model of models) expect(findModel(modelId(model))).toEqual(model)
})

test('libfx conversation becomes Pi text, images, tool calls and tool results', () => {
  const model = findModel('anthropic/claude-sonnet-4-5')
  const context = piContext({ prompt: [
    { role: 'system', content: 'Design a page' },
    { role: 'user', content: [{ type: 'text', text: 'Use this' }, { type: 'file', data: 'data:image/png;base64,aGVsbG8=', mediaType: 'image/png' }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'publish_design', input: { html: '<h1>Hello</h1>' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'publish_design', output: { type: 'json', value: { ok: true } } }] },
  ] }, model)
  expect(context.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'toolResult'])
  expect(context.messages[1].content[1]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' })
  expect(context.messages[2].content[0].arguments.html).toBe('<h1>Hello</h1>')
  expect(context.messages[3].content[0].text).toBe('{"ok":true}')
})

test('reasoning and tool signatures survive libfx provider replay and model switches', () => {
  const previous = findModel('anthropic/claude-sonnet-4-5')
  const thinking = { type: 'thinking', thinking: 'Reason', thinkingSignature: 'fixture-signature', redacted: false }
  const call = { type: 'toolCall', id: 'call-1', name: 'publish_design', arguments: {}, thoughtSignature: 'fixture-thought' }
  const next = findModel('openai/gpt-4o')
  const context = piContext({ prompt: [{ role: 'assistant', content: [
    { type: 'reasoning', text: thinking.thinking, providerOptions: piReplayMetadata(previous, thinking) },
    { type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.arguments, providerOptions: piReplayMetadata(previous, call) },
  ] }] }, next)
  expect(context.messages[0].model).toBe(previous.id)
  expect(context.messages[0].content[0]).toEqual(thinking)
  expect(context.messages[0].content[1].thoughtSignature).toBe(call.thoughtSignature)
})

test('private assets persist, paginate, reject traversal and delete on real disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fx0-assets-'))
  process.env.FX0_DATA_DIR = directory
  try {
    await fileAssets.put('chat/a', new TextEncoder().encode('hello'))
    await fileAssets.put('chat/b', new TextEncoder().encode('world'))
    expect(await new Response((await fileAssets.get('chat/a')).stream).text()).toBe('hello')
    const page = await fileAssets.list({ prefix: 'chat/', limit: 1 })
    expect(page.hasMore).toBe(true)
    expect((await fileAssets.list({ prefix: 'chat/', cursor: page.cursor, limit: 1 })).blobs[0].pathname).toBe('chat/b')
    await expect(fileAssets.get('../outside')).rejects.toThrow()
    await fileAssets.del(['chat/a', 'chat/b'])
    expect(await fileAssets.get('chat/a')).toBeNull()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('Postgres enforces real ownership and isolates chat history', async () => {
  if (!process.env.DATABASE_URL) throw new Error('Real Postgres DATABASE_URL required')
  const user = { id: `fx0-test:${randomUUID()}`, name: 'Integration', email: null, picture: null }
  const session = randomUUID()
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await reserveSession(user, session, null)
    await assertSessionOwner(user.id, session)
    await expect(assertSessionOwner(`${user.id}:other`, session)).rejects.toThrow()
    expect(await ownedSessionIds(user.id)).toContain(session)
    expect(await ownedSessionIds(`${user.id}:other`)).not.toContain(session)
    await removeOwnedSession(user.id, session)
    await expect(assertSessionOwner(user.id, session)).rejects.toThrow()
  } finally {
    await pool.query('DELETE FROM fx0_chat_ownership WHERE session_id=$1', [session])
    await pool.query('DELETE FROM fx0_accounts WHERE id=$1', [user.id])
    await pool.end()
  }
})
