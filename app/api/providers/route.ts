import { withUserRoute } from '../../../lib/route-auth'
import { piModels } from '../../../lib/pi-models'
import { answerProviderLogin, loginView, providerLogin, startProviderLogin } from '../../../lib/provider-login'
import { AuthError, withAccountDatabase } from '../../../lib/accounts'
import type { AuthType } from '@earendil-works/pi-ai'

export const GET = withUserRoute(async (request, { user }) => {
  const id = new URL(request.url).searchParams.get('login')
  if (id) return Response.json(loginView(user.id, id))
  const saved = new Set(await withAccountDatabase(async q => (await q('SELECT provider_id FROM fx0_provider_credentials')).map(row => String(row.provider_id))))
  const providers = await Promise.all(piModels.getProviders().map(async p => ({
    id: p.id, name: p.name, models: p.getModels().length,
    configured: !!await piModels.checkAuth(p.id),
    hasSavedCredentials: saved.has(p.id),
    methods: [p.auth.apiKey?.login ? { type: 'api_key', label: p.auth.apiKey.name } : null,
      p.auth.oauth ? { type: 'oauth', label: p.auth.oauth.loginLabel ?? p.auth.oauth.name } : null].filter(Boolean),
  })))
  return Response.json({ providers })
})

export const POST = withUserRoute(async (request, { user }) => {
  const body = await request.json()
  if (typeof body.login === 'string') {
    if (body.cancel) providerLogin(user.id, body.login).abort.abort()
    else {
      if (typeof body.prompt !== 'string' || typeof body.value !== 'string' || body.value.length > 32_768) throw new AuthError(400, 'Invalid login answer')
      answerProviderLogin(user.id, body.login, body.prompt, body.value)
    }
    return Response.json(loginView(user.id, body.login))
  }
  if (typeof body.provider !== 'string') throw new AuthError(400, 'Provider required')
  const id = startProviderLogin(user.id, body.provider, body.type as AuthType)
  return Response.json(loginView(user.id, id), { status: 202 })
})

export const DELETE = withUserRoute(async (request) => {
  const { provider } = await request.json()
  if (typeof provider !== 'string' || !piModels.getProvider(provider)) throw new AuthError(400, 'Unknown provider')
  await piModels.logout(provider)
  return Response.json({ ok: true })
})
