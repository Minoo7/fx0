import { randomUUID } from 'node:crypto'
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai'
import { piModels } from './pi-models'
import { AuthError } from './accounts'

type Prompt = Omit<AuthPrompt, 'signal'> & { id: string }
interface Login {
  owner: string
  provider: string
  events: AuthEvent[]
  prompt?: Prompt
  answer?: (value: string) => void
  status: 'pending' | 'done' | 'failed'
  abort: AbortController
}
const globalLogins = globalThis as unknown as { fx0ProviderLogins?: Map<string, Login> }
const logins = globalLogins.fx0ProviderLogins ??= new Map<string, Login>()

export function startProviderLogin(owner: string, provider: string, type: AuthType): string {
  const entry = piModels.getProvider(provider)
  if (!entry || (type !== 'api_key' && type !== 'oauth') || (type === 'oauth' ? !entry.auth.oauth : !entry.auth.apiKey?.login)) {
    throw new AuthError(400, 'Unsupported provider login method')
  }
  const id = randomUUID()
  const login: Login = { owner, provider, events: [], status: 'pending', abort: new AbortController() }
  logins.set(id, login)
  const timer = setTimeout(() => {
    login.abort.abort()
    logins.delete(id)
  }, 10 * 60_000)
  timer.unref()
  void piModels.login(provider, type, {
    signal: login.abort.signal,
    notify(event) {
      login.events.push(event)
      if (login.events.length > 30) login.events.shift()
    },
    prompt: async ({ signal, ...prompt }) => new Promise<string>((resolve, reject) => {
      login.prompt = { ...prompt, id: randomUUID() }
      const abort = () => {
        login.answer = undefined
        login.prompt = undefined
        reject(new Error('Login cancelled'))
      }
      login.abort.signal.addEventListener('abort', abort, { once: true })
      signal?.addEventListener('abort', abort, { once: true })
      login.answer = value => {
        login.abort.signal.removeEventListener('abort', abort)
        signal?.removeEventListener('abort', abort)
        login.answer = undefined
        login.prompt = undefined
        resolve(value)
      }
    }),
  }, { agentName: 'fx0' }).then(() => {
    login.status = 'done'
    login.prompt = undefined
  }, () => {
    login.status = 'failed'
    login.prompt = undefined
  })
  return id
}

export function providerLogin(owner: string, id: string): Login {
  const login = logins.get(id)
  if (!login || login.owner !== owner) throw new AuthError(404, 'Provider login expired; start again')
  return login
}

export function loginView(owner: string, id: string) {
  const { provider, status, events, prompt } = providerLogin(owner, id)
  return { id, provider, status, events, prompt }
}

export function answerProviderLogin(owner: string, id: string, promptId: string, value: string): void {
  const login = providerLogin(owner, id)
  if (login.prompt?.id !== promptId || !login.answer) throw new AuthError(409, 'Login prompt changed; retry')
  login.answer(value)
}
