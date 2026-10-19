// The models the picker opens on, chosen as fx's own picker chooses them
// (src/core/gateway/model_catalog.zig in vercel-labs/fx): the newest model of
// each family below, from the live catalog, so the list never names a model ID.
const FEATURED_FAMILIES = [
  'anthropic/claude-fable',
  'openai/gpt',
  'xai/grok-build',
  'anthropic/claude-opus',
  'zai/glm',
  'deepseek/deepseek',
  'minimax/minimax',
]

export interface CatalogModel {
  id: string
  released?: number
}

// "openai/gpt-6.1-sol" belongs to "openai/gpt": the ID up to its first "-<digit>".
function family(id: string): string {
  if (id.startsWith('openai/gpt-') && id.includes('-codex')) return 'openai/gpt-codex'
  if (id.startsWith('deepseek/deepseek-')) return 'deepseek/deepseek'
  if (id.startsWith('minimax/minimax-')) return 'minimax/minimax'
  const version = id.slice(id.indexOf('/') + 1).search(/-\d/)
  return version === -1 ? id : id.slice(0, id.indexOf('/') + 1 + version)
}

function featurable(id: string): boolean {
  const lower = id.toLowerCase()
  if (lower.includes('claude-sonnet')) return false
  if (lower.startsWith('zai/glm-') && lower.endsWith('-fast')) return false
  return !['-mini', '-nano', '-oss', '-safeguard'].some((variant) => lower.includes(variant))
}

// DeepSeek releases several variants at once; prefer the strongest.
function deepseekRank(id: string): number {
  if (id.endsWith('-pro')) return 0
  if (id.includes('-thinking') || id.includes('-reasoning')) return 1
  return id.includes('-flash') ? 3 : 2
}

// Newer first; at equal release, the shorter ID, so a base model beats its "-fast" twin.
function newer(group: string, a: CatalogModel, b: CatalogModel): number {
  const released = (b.released ?? 0) - (a.released ?? 0)
  if (released !== 0) return released
  if (group === 'deepseek/deepseek' && deepseekRank(a.id) !== deepseekRank(b.id)) return deepseekRank(a.id) - deepseekRank(b.id)
  return a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export function featuredModels(models: CatalogModel[]): string[] {
  const featured: string[] = []
  for (const group of FEATURED_FAMILIES) {
    const newest = models
      .filter((model) => featurable(model.id) && family(model.id) === group)
      .sort((a, b) => newer(group, a, b))[0]
    if (newest && !featured.includes(newest.id)) featured.push(newest.id)
  }
  return featured
}
