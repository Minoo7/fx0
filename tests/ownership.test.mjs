import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { AuthError, createAccountStore, isNewSessionId } from '../lib/accounts.ts'

const id = 'a4b0d934-8e2a-4c19-924e-18a491b16767'
const user = { id: 'user_a', name: 'Account A', email: 'a@example.test', picture: null }

function database() {
  const owners = new Map()
  const billingTeams = new Map()
  const calls = []
  const query = async (text, values = []) => {
    calls.push({ text, values })
    if (text.startsWith('SELECT user_id')) {
      return owners.has(values[0]) ? [{ user_id: owners.get(values[0]), billing_team_id: billingTeams.get(values[0]) }] : []
    }
    if (text.startsWith('WITH account')) {
      if (owners.has(values[0])) return []
      owners.set(values[0], values[1])
      billingTeams.set(values[0], values[5])
      return [{ session_id: values[0] }]
    }
    if (text.startsWith('SELECT session_id')) {
      return [...owners].filter(([, owner]) => owner === values[0]).map(([session_id]) => ({ session_id }))
    }
    if (text.startsWith('DELETE')) {
      if (owners.get(values[0]) !== values[1]) return []
      owners.delete(values[0])
      return [{ session_id: values[0] }]
    }
    throw new Error('Unexpected query')
  }
  return { owners, billingTeams, calls, store: createAccountStore(query) }
}

const denied = (error) => error instanceof AuthError && error.status === 404

test('callback metadata upsert stores only parameterized public identity fields', async () => {
  const calls = []
  const store = createAccountStore(async (text, values) => { calls.push({ text, values }); return [] })
  await store.upsertAccount({ ...user, accessToken: 'must-not-store', refreshToken: 'must-not-store' })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].values, [user.id, user.name, user.email, null])
  assert.match(calls[0].text, /INSERT INTO fx0_accounts \(id, name, email, picture\)/)
  assert.doesNotMatch(JSON.stringify(calls), /must-not-store|accessToken|refreshToken/)
})

test('existing ownership uses one SELECT and never auto-claims unknown or foreign chats', async () => {
  const db = database()
  db.owners.set(id, user.id)
  await db.store.assertSessionOwner(user.id, id)
  assert.equal(db.calls.length, 1)
  assert.match(db.calls[0].text, /^SELECT user_id/)
  await assert.rejects(db.store.assertSessionOwner('user_b', id), denied)
  await assert.rejects(db.store.assertSessionOwner(user.id, 'unknown'), denied)
  assert.equal(db.calls.length, 3)
  assert.ok(db.calls.every(({ text }) => text.startsWith('SELECT')))
  assert.equal(db.owners.size, 1)
})

test('reservation is a single parameterized account + immutable owner and billing team write', async () => {
  const db = database()
  await db.store.reserveSession(user, id, 'team_a')
  assert.equal(db.calls.length, 1)
  const { text, values } = db.calls[0]
  assert.match(text, /WITH account/)
  assert.match(text, /ON CONFLICT \(session_id\) DO NOTHING RETURNING session_id/)
  assert.match(text, /INSERT INTO fx0_chat_ownership \(session_id, user_id, billing_team_id\)/)
  assert.match(text, /SELECT \$1, id, \$6 FROM account/)
  assert.deepEqual(values, [id, user.id, user.name, user.email, null, 'team_a'])
  const results = await Promise.allSettled([
    db.store.reserveSession({ ...user, id: 'user_b' }, id, 'team_b'),
    db.store.reserveSession(user, id, 'team_b'),
  ])
  assert.ok(results.every((result) => result.status === 'rejected' && denied(result.reason)))
  assert.equal(db.owners.get(id), user.id)
  assert.equal(db.billingTeams.get(id), 'team_a')
})

test('ownership is one SELECT and foreign or unknown chats stay 404, whatever team bills', async () => {
  const db = database()
  db.owners.set(id, user.id)
  db.billingTeams.set(id, 'team_a')
  await db.store.assertSessionOwner(user.id, id)
  assert.equal(db.calls.length, 1)
  assert.match(db.calls[0].text, /^SELECT user_id FROM fx0_chat_ownership/)
  await assert.rejects(db.store.assertSessionOwner('user_b', id), denied)
  await assert.rejects(db.store.assertSessionOwner(user.id, 'unknown'), denied)
  assert.ok(db.calls.every(({ text }) => text.startsWith('SELECT')))
  assert.equal(db.billingTeams.get(id), 'team_a')
})

test('reservation rejects missing or invalid billing teams before writing', async () => {
  const db = database()
  for (const team of [undefined, null, '', 'user_a', 'other_team_a']) {
    await assert.rejects(db.store.reserveSession(user, id, team), (error) => error.status === 403)
  }
  assert.equal(db.calls.length, 0)
})

test('new ownership requires full random UUID v4 while old owned IDs remain readable', async () => {
  const db = database()
  for (const invalid of ['deadbeef', 'lobby', 'a4b0d934-8e2a-1c19-924e-18a491b16767']) {
    assert.equal(isNewSessionId(invalid), false)
    await assert.rejects(db.store.reserveSession(user, invalid, 'team_a'), (error) => error.status === 400)
  }
  assert.equal(db.calls.length, 0)
  db.owners.set('deadbeef', user.id)
  await db.store.assertSessionOwner(user.id, 'deadbeef')
  await assert.rejects(db.store.assertSessionOwner(user.id, '../deadbeef'), denied)
})

test('list and delete are user-filtered and deletion never removes another owner', async () => {
  const db = database()
  db.owners.set(id, user.id)
  db.owners.set('foreign', 'user_b')
  assert.deepEqual(await db.store.ownedSessionIds(user.id), [id])
  assert.match(db.calls[0].text, /WHERE user_id = \$1/)
  await assert.rejects(db.store.removeOwnedSession(user.id, 'foreign'), denied)
  assert.equal(db.owners.get('foreign'), 'user_b')
  await db.store.removeOwnedSession(user.id, id)
  assert.equal(db.owners.has(id), false)
  assert.match(db.calls.at(-1).text, /session_id = \$1 AND user_id = \$2/)
})

test('migration has only metadata and indexed ownership; production uses HTTP Neon not pools', async () => {
  const migration = await readFile(new URL('../migrations/001_accounts.sql', import.meta.url), 'utf8')
  assert.equal((migration.match(/CREATE TABLE/g) ?? []).length, 2)
  assert.doesNotMatch(migration, /access_token|refresh_token|login_sessions|oauth_flows/)
  assert.match(migration, /ON fx0_chat_ownership\(user_id, created_at DESC\)/)
  assert.match(migration, /billing_team_id text NOT NULL CHECK \(billing_team_id ~ '\^team_'\)/)
  const source = await readFile(new URL('../lib/accounts.ts', import.meta.url), 'utf8')
  assert.match(source, /neon\(connectionString\)/)
  assert.doesNotMatch(source, /new Pool|webSocketConstructor|query\('BEGIN'/)
})

test('chat pages are user-scoped, bounded and seek across equal activity timestamps', async () => {
  const at = '2026-10-12T10:00:00.000Z'
  const rows = Array.from({ length: 81 }, (_, i) => ({ session_id: `chat-${String(80 - i).padStart(3, '0')}`, activity_at: at }))
  const calls = []
  const store = createAccountStore(async (text, values) => {
    calls.push({ text, values })
    return rows.filter((row) => !values[2] || row.session_id < values[2]).slice(0, values[3])
  })
  const first = await store.ownedSessionPage(user.id)
  const second = await store.ownedSessionPage(user.id, first.nextCursor)
  const last = await store.ownedSessionPage(user.id, second.nextCursor)
  assert.deepEqual([first.ids.length, second.ids.length, last.ids.length], [40, 40, 1])
  assert.equal(new Set([...first.ids, ...second.ids, ...last.ids]).size, 81)
  assert.equal(last.nextCursor, null)
  assert.ok(calls.every(({ text, values }) => /WHERE user_id = \$1/.test(text) && /LIMIT \$4/.test(text) && values[0] === user.id && values[3] === 41))
  assert.ok(calls.every(({ text }) => /title IS NOT NULL/.test(text)), 'empty reservations cannot consume a sidebar page')
  const count = calls.length
  for (const cursor of ['?', Buffer.from('{"at":"invalid","id":"chat"}').toString('base64url'), 'x'.repeat(301)]) {
    await assert.rejects(store.ownedSessionPage(user.id, cursor), (error) => error.status === 400)
  }
  assert.equal(calls.length, count, 'invalid cursors never reach the database')
})

test('admitted prompt activity preserves the first title and cannot move backwards', async () => {
  const calls = []
  const store = createAccountStore(async (text, values) => { calls.push({ text, values }); return [] })
  await store.touchOwnedSession(user.id, id, '☕'.repeat(45), 1234)
  assert.match(calls[0].text, /COALESCE\(title, \$3\)/)
  assert.match(calls[0].text, /GREATEST\(updated_at/)
  assert.match(calls[0].text, /WHERE session_id = \$1 AND user_id = \$2/)
  assert.deepEqual(calls[0].values, [id, user.id, '☕'.repeat(40), 1234])
})
