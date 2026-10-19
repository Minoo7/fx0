import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryRedis, turnCredentialWith } from './fixtures/memory-redis.mjs'

// Every paid turn bills the login and team that sent the message starting it,
// whatever the chat's later messages and token renewals send.

const HOUR = 3_600_000

function useSecret(t) {
  const previous = process.env.SESSION_SECRET
  process.env.SESSION_SECRET = 'turn-funding-test-session-password'
  t.after(() => { if (previous === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous })
}

function session(loginId, teamId, accessToken = `${loginId}-${teamId}`) {
  return { userId: 'user-a', loginId, teamId, accessToken, email: 'a@example.com', loginAt: 1, isLoggedIn: true, expiresAt: Date.now() + HOUR }
}

// What a turn bills: [login, team, token], or why it bills nothing.
async function billed(credentials, turnId) {
  const funding = await credentials.readExecutionFunding('chat', turnId)
  return funding.ok ? [funding.credential.loginId, funding.credential.teamId, funding.credential.accessToken] : funding.refused
}

test('a paid turn keeps its sender\'s login and team when another login or team sends the next message', async (t) => {
  useSecret(t)
  const credentials = await turnCredentialWith(t, memoryRedis())
  await credentials.saveTurnCredential('chat', session('laptop', 'team_a'), 1)
  await credentials.saveTurnCredential('chat', session('phone', 'team_b'), 2)
  assert.deepEqual(await billed(credentials, 1), ['laptop', 'team_a', 'laptop-team_a'])
  assert.deepEqual(await billed(credentials, 2), ['phone', 'team_b', 'phone-team_b'])

  // The laptop switches teams. Its new token reaches its running turn, which
  // still bills the team its message chose.
  await credentials.saveTurnCredential('chat', session('laptop', 'team_b', 'laptop-new'), 3)
  assert.deepEqual(await billed(credentials, 1), ['laptop', 'team_a', 'laptop-new'])
  assert.deepEqual(await billed(credentials, 2), ['phone', 'team_b', 'phone-team_b'])
  assert.deepEqual(await billed(credentials, 3), ['laptop', 'team_b', 'laptop-new'])

  // A renewal from the phone reaches only the phone's turn.
  await credentials.renewLatestCredential('chat', session('phone', 'team_b', 'phone-renewed'))
  assert.deepEqual(await billed(credentials, 1), ['laptop', 'team_a', 'laptop-team_a'])
  assert.deepEqual(await billed(credentials, 2), ['phone', 'team_b', 'phone-renewed'])
  assert.deepEqual(await billed(credentials, 3), ['laptop', 'team_b', 'laptop-new'])
})

test('no later message or renewal changes who pays for an earlier turn', async (t) => {
  useSecret(t)
  const credentials = await turnCredentialWith(t, memoryRedis())
  let seed = 0x5eed
  const pick = (items) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return items[seed % items.length] }
  for (let run = 0; run < 25; run++) {
    globalThis.__memoryRedis = memoryRedis().client
    const funders = new Map() // turn -> [login, team]
    const tokens = new Map() // login -> every token it stored
    let token = 0
    for (let step = 0; step < 6; step++) {
      const sent = session(pick(['laptop', 'phone', 'tablet']), pick(['team_a', 'team_b']), `token-${++token}`)
      tokens.set(sent.loginId, [...(tokens.get(sent.loginId) ?? []), sent.accessToken])
      if (funders.size && pick([true, false, false])) {
        await credentials.renewLatestCredential('chat', sent)
      } else {
        const turnId = funders.size + 1
        await credentials.saveTurnCredential('chat', sent, turnId)
        funders.set(turnId, [sent.loginId, sent.teamId])
      }
      for (const [turnId, [loginId, teamId]] of funders) {
        const where = `run ${run}, step ${step}, turn ${turnId}`
        const pays = await billed(credentials, turnId)
        assert.deepEqual(pays.slice(0, 2), [loginId, teamId], where)
        assert.ok(tokens.get(loginId).includes(pays[2]), `${where}: a token of another login`)
      }
    }
  }
})

test('a chat from before per-turn funding bills its latest credential until its first pinned message', async (t) => {
  useSecret(t)
  const credentials = await turnCredentialWith(t, memoryRedis())
  // Before this change a paid message stored only the chat's latest credential.
  await credentials.renewLatestCredential('chat', session('laptop', 'team_a'))
  assert.deepEqual(await billed(credentials, 4), ['laptop', 'team_a', 'laptop-team_a'], 'a turn running across the deploy')
  assert.deepEqual(await billed(credentials, undefined), ['laptop', 'team_a', 'laptop-team_a'])

  await credentials.saveTurnCredential('chat', session('phone', 'team_b'), 5)
  assert.equal(await billed(credentials, 4), 'unbound-turn', 'the old turn cannot bill the new sender')
  assert.equal(await billed(credentials, undefined), 'no-turn')
  assert.deepEqual(await billed(credentials, 5), ['phone', 'team_b', 'phone-team_b'])
})

test('a paid message whose credential cannot be stored is not admitted', async (t) => {
  useSecret(t)
  const store = memoryRedis()
  const credentials = await turnCredentialWith(t, store)
  await assert.rejects(credentials.saveTurnCredential('chat', { ...session('laptop', 'team_a'), expiresAt: Date.now() - 1 }, 1), /Sign in again/)
  await assert.rejects(credentials.saveTurnCredential('chat', { ...session('laptop', 'team_a'), teamId: '' }, 1), /Sign in again/)
  assert.equal(store.values.size + store.hashes.size, 0)
})

test('sign-out drops the departing login\'s turn credentials and keeps every funding record', async (t) => {
  useSecret(t)
  const credentials = await turnCredentialWith(t, memoryRedis())
  await credentials.saveTurnCredential('chat', session('laptop', 'team_a'), 1)
  await credentials.saveTurnCredential('chat', session('phone', 'team_b'), 2)
  assert.deepEqual(await credentials.dropLoginCredentials('laptop'), [{ chatId: 'chat', latestWasLogin: false }])
  assert.equal(await billed(credentials, 1), 'unusable')
  assert.deepEqual(await billed(credentials, 2), ['phone', 'team_b', 'phone-team_b'])
  assert.equal((await credentials.readTurnFunding('chat', 1)).loginId, 'laptop')
  assert.equal((await credentials.readTurnFunding('chat', 2)).loginId, 'phone')
  assert.equal(await credentials.readTurnFunding('chat', 3), null)
  assert.deepEqual(await credentials.dropLoginCredentials('phone'), [{ chatId: 'chat', latestWasLogin: true }])
  assert.equal(await billed(credentials, 2), 'unusable')
})

test('resolution bills a turn\'s recorded identity and team, or nothing', async (t) => {
  const { resolveFunding } = await turnCredentialWith(t, memoryRedis())
  const user = (loginId, teamId) => ({ userId: 'user-a', loginId, teamId, accessToken: `${loginId}-${teamId}`, expiresAt: Date.now() + HOUR })
  const trial = (loginId) => ({ kind: 'trial', userId: 'user-a', loginId, expiresAt: Date.now() + HOUR })
  const credentials = [null, trial('laptop'), trial('phone'), user('laptop', 'team_a'), user('laptop', 'team_b'), user('phone', 'team_a')]
  const bindings = [null, { kind: 'trial', userId: 'user-a', loginId: 'laptop' }, { kind: 'user', userId: 'user-a', loginId: 'laptop', teamId: 'team_a' }]
  for (const records of [0, 1]) for (const turnId of [null, 7]) for (const binding of bindings) {
    for (const exact of credentials) for (const latest of credentials) {
      const where = JSON.stringify({ records, turnId, binding, exact, latest })
      const funding = resolveFunding(records, turnId, binding, exact, latest)
      if (records === 0) {
        assert.equal(funding.ok, !!latest && !('kind' in latest), where)
        if (funding.ok) assert.equal(funding.credential, latest, where)
        continue
      }
      if (!funding.ok) continue
      assert.ok(turnId !== null && binding, where)
      assert.deepEqual([funding.credential.userId, funding.credential.loginId], [binding.userId, binding.loginId], where)
      assert.equal('kind' in funding.credential, binding.kind === 'trial', where)
      if (binding.kind === 'user') assert.equal(funding.credential.teamId, binding.teamId, where)
    }
  }
})
