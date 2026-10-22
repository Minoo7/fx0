import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { subscribe, unsubscribe } from 'node:diagnostics_channel'
import { Pool } from 'pg'
import { unsealData } from 'iron-session'
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { withChatGPTModels } from '../lib/chatgpt-provider.ts'

test('real ChatGPT catalog is cached, force-refreshable, and credential-scoped', async () => {
  const database = await readFile('/secrets/database', 'utf8')
  const password = await readFile('/secrets/session', 'utf8')
  const pool = new Pool({ connectionString: `postgresql://fx0:${encodeURIComponent(database)}@postgres:5432/fx0` })
  let requests = 0
  const count = ({ request }) => {
    if (String(request.origin) === 'https://api.openai.com' && request.path === '/v1/models') requests++
  }
  subscribe('undici:request:create', count)
  try {
    const { rows } = await pool.query('SELECT credential FROM fx0_provider_credentials WHERE provider_id=$1', ['openai'])
    assert.ok(rows.length, 'Requires saved ChatGPT credentials in the selfhost deployment')
    const credential = await unsealData(rows[0].credential, { password, ttl: 0 })
    assert.equal(credential.type, 'oauth')
    assert.ok(credential.expires > Date.now() + 60_000, 'Refresh the deployment connection before running this test')
    const credentials = new InMemoryCredentialStore()
    await credentials.modify('openai', async () => credential)
    const models = createModels({ credentials })
    models.setProvider(withChatGPTModels(openaiProvider()))
    const refresh = options => models.refresh({ providers: ['openai'], signal: AbortSignal.timeout(15_000), ...options })
    assert.equal((await refresh()).errors.size, 0)
    const available = (await models.getAvailable('openai')).map(model => model.id)
    assert.ok(available.length > 0)
    const initialRequests = requests
    assert.equal(initialRequests, 1)
    for (let i = 0; i < 3; i++) assert.equal((await refresh()).errors.size, 0)
    assert.equal(requests, initialRequests, 'Warm validation must not repeat account discovery')
    assert.deepEqual((await models.getAvailable('openai')).map(model => model.id), available)
    assert.equal((await refresh({ force: true })).errors.size, 0)
    assert.equal(requests, initialRequests + 1)
    await credentials.delete('openai')
    assert.deepEqual(await models.getAvailable('openai'), [])
    await credentials.modify('openai', async () => ({ ...credential, access: 'invalid-catalog-regression-credential' }))
    assert.equal((await refresh()).errors.size, 1)
    assert.equal(requests, initialRequests + 2, 'Changed credentials must bypass the cache')
    assert.deepEqual(await models.getAvailable('openai'), [], 'An invalid connection must not inherit the previous account catalog')
  } finally {
    unsubscribe('undici:request:create', count)
    await pool.end()
  }
})
