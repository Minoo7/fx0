import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { createProvider, envApiKeyAuth, type Api, type Credential, type CredentialStore, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { sealData, unsealData } from 'iron-session'
import { Pool } from 'pg'
import { withAccountDatabase, AuthError } from './accounts'

let credentialPool: Pool | undefined
function credentialPassword(): string {
  const secret = process.env.SESSION_SECRET
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters')
  return secret
}

const credentials: CredentialStore = {
  async read(providerId) {
    const rows = await withAccountDatabase(q => q('SELECT credential FROM fx0_provider_credentials WHERE provider_id=$1', [providerId]))
    return rows[0] ? unsealData<Credential>(String(rows[0].credential), { password: credentialPassword(), ttl: 0 }) : undefined
  },
  async list() {
    const rows = await withAccountDatabase(q => q('SELECT provider_id, credential_type FROM fx0_provider_credentials'))
    return rows.map(row => ({ providerId: String(row.provider_id), type: row.credential_type as Credential['type'] }))
  },
  async modify(providerId, fn) {
    credentialPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000 })
    const client = await credentialPool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [providerId])
      const { rows } = await client.query('SELECT credential FROM fx0_provider_credentials WHERE provider_id=$1', [providerId])
      const current = rows[0] ? await unsealData<Credential>(rows[0].credential, { password: credentialPassword(), ttl: 0 }) : undefined
      const next = await fn(current)
      if (next) await client.query(`INSERT INTO fx0_provider_credentials(provider_id,credential_type,credential) VALUES($1,$2,$3)
        ON CONFLICT(provider_id) DO UPDATE SET credential_type=EXCLUDED.credential_type,credential=EXCLUDED.credential`,
      [providerId, next.type, await sealData(next, { password: credentialPassword(), ttl: 0 })])
      await client.query('COMMIT')
      return next ?? current
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  },
  async delete(providerId) {
    credentialPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000 })
    const client = await credentialPool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [providerId])
      await client.query('DELETE FROM fx0_provider_credentials WHERE provider_id=$1', [providerId])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  },
}

export const piModels = builtinModels({ credentials })

// Custom OpenAI-compatible endpoints use Pi's provider extension unchanged.
if (process.env.FX0_CUSTOM_PROVIDERS) {
  const configured = JSON.parse(process.env.FX0_CUSTOM_PROVIDERS) as {
    id: string; name?: string; baseUrl: string; apiKeyEnv?: string; models: Model<'openai-completions'>[]
  }[]
  for (const provider of configured) piModels.setProvider(createProvider({
    ...provider,
    auth: { apiKey: provider.apiKeyEnv ? envApiKeyAuth(provider.name ?? provider.id, [provider.apiKeyEnv])
      : { name: provider.name ?? provider.id, resolve: async () => ({ auth: {} }) } },
    api: openAICompletionsApi(),
  }))
}

export function modelId(model: Model<Api>): string {
  return `${model.provider}/${model.id}`
}
export function findModel(id: string): Model<Api> {
  const separator = id.indexOf('/')
  const model = piModels.getModel(id.slice(0, separator), id.slice(separator + 1))
  if (!model) throw new AuthError(400, 'Unknown Pi model')
  return model
}

export async function assertModelAccess(id: string): Promise<void> {
  const model = findModel(id)
  if (!await piModels.getAuth(model)) throw new AuthError(503, `Connect ${model.provider} in model providers before generating a design.`)
}

export function libfxCatalog() {
  return piModels.getModels().map(model => ({
    id: modelId(model), type: 'language', context_window: model.contextWindow,
    max_tokens: model.maxTokens,
    reasoning_options: model.reasoning ? [{ type: 'effort', values: Object.entries(model.thinkingLevelMap ?? { low: '', medium: '', high: '' }).filter(([key, value]) => key !== 'off' && value !== null).map(([key]) => key) }] : [],
  }))
}
