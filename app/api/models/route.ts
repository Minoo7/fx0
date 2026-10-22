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
  const models = piModels.getModels()
  const available = await piModels.getAvailable()
  const efforts = Object.fromEntries(models.filter(m => m.reasoning).map(m => [modelId(m),
    Object.entries(m.thinkingLevelMap ?? { low: '', medium: '', high: '' }).filter(([level, value]) => level !== 'off' && value !== null).map(([level]) => level)]))
  return Response.json({ models: models.map(modelId).sort(), defaultModel: process.env.FX0_MODEL ?? DEFAULT_MODEL,
    efforts, fast: [], featured: available.slice(0, 12).map(modelId) } satisfies ModelCatalog)
})
