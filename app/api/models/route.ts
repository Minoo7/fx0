import { piModels, modelId } from '../../../lib/pi-models'
import { DEFAULT_MODEL } from '../../../lib/session'
import { withUserRoute } from '../../../lib/route-auth'

export const maxDuration = 60
export interface ModelCatalog {
  models: string[]
  defaultModel: string
  efforts: Record<string, string[]>
  fast: string[]
  featured: string[]
}
let refreshedAt = 0
export const GET = withUserRoute(async () => {
  if (Date.now() - refreshedAt > 300_000) {
    await piModels.refresh({ allowNetwork: true, signal: AbortSignal.timeout(15_000) })
    refreshedAt = Date.now()
  }
  const models = await piModels.getAvailable()
  const efforts = Object.fromEntries(models.filter(m => m.reasoning).map(m => [modelId(m),
    Object.entries(m.thinkingLevelMap ?? { low: '', medium: '', high: '' }).filter(([level, value]) => level !== 'off' && value !== null).map(([level]) => level)]))
  const ids = models.map(modelId).sort()
  const preferred = process.env.FX0_MODEL ?? DEFAULT_MODEL
  return Response.json({ models: ids, defaultModel: ids.includes(preferred) ? preferred : ids[0] ?? '',
    efforts, fast: [], featured: models.slice(0, 12).map(modelId) } satisfies ModelCatalog)
})
