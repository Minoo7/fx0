import type { Model, Provider } from '@earendil-works/pi-ai'

export function chatgptModels(value: unknown): Model<'openai-responses'>[] {
  if (!value || typeof value !== 'object' || !('models' in value) || !Array.isArray(value.models)) {
    throw new Error('Invalid ChatGPT model catalog')
  }
  return value.models.filter(model => model.visibility === 'list' && model.supported_in_api !== false).map(model => {
    if (typeof model.slug !== 'string' || !model.slug || typeof model.display_name !== 'string'
      || !Number.isSafeInteger(model.context_window) || model.context_window <= 0
      || !Array.isArray(model.input_modalities) || !model.input_modalities.includes('text')
      || !Array.isArray(model.supported_reasoning_levels)) throw new Error('Invalid ChatGPT model metadata')
    const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const supported = model.supported_reasoning_levels.map((level: { effort: string }) => level.effort)
    return {
      id: model.slug, name: model.display_name, provider: 'openai', api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1', input: model.input_modalities.filter((input: string) => input === 'text' || input === 'image'),
      contextWindow: model.context_window,
      // shortcut: account catalogs omit output limits; cap at 32K until they publish them.
      maxTokens: Math.min(32_768, model.context_window),
      reasoning: supported.length > 0,
      thinkingLevelMap: Object.fromEntries(['off', ...levels].map(level => [level, supported.includes(level) ? level : null])),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
  })
}

export function withChatGPTModels(provider: Provider): Provider {
  let access: string | undefined
  let models: Model<'openai-responses'>[] = []
  let refreshedAt = 0
  return {
    ...provider,
    getModels: () => [...models, ...provider.getModels().filter(model => !models.some(current => current.id === model.id))],
    filterModels: (catalog, credential) => credential?.type === 'oauth'
      ? credential.access === access ? models : []
      : provider.filterModels?.(catalog, credential) ?? provider.getModels(),
    async refreshModels(context) {
      if (!context.allowNetwork || context.credential?.type !== 'oauth') return
      const token = context.credential.access
      if (!context.force && token === access && Date.now() - refreshedAt < 300_000) return
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${token}` }, signal: context.signal,
      })
      if (!response.ok) throw new Error(`ChatGPT model discovery failed (${response.status})`)
      const next = chatgptModels(await response.json())
      await context.publish({ update: () => { models = next; access = token; refreshedAt = Date.now() } })
    },
  }
}
