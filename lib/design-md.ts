// The ten most-installed DESIGN.md files on getdesign.md (install counts read on
// 2026-10-05). The files in ./design-md/ are VoltAgent/awesome-design-md at
// 13be5c0, unmodified (MIT, see ./design-md/LICENSE). They are analyses of each
// brand's public website, not files the brands publish themselves.

export interface DesignMdOption {
  id: string
  name: string
  description: string
}

// Descriptions are the style half of getdesign.md's own one-line summaries.
export const DESIGN_MD_CATALOG: readonly DesignMdOption[] = [
  { id: 'apple', name: 'Apple', description: 'Premium white space, SF Pro, cinematic imagery.' },
  { id: 'claude', name: 'Claude', description: 'Warm terracotta accent, clean editorial layout.' },
  { id: 'vercel', name: 'Vercel', description: 'Black and white precision, Geist font.' },
  { id: 'notion', name: 'Notion', description: 'Warm minimalism, serif headings, soft surfaces.' },
  { id: 'airbnb', name: 'Airbnb', description: 'Warm coral accent, photography-driven, rounded UI.' },
  { id: 'linear.app', name: 'Linear', description: 'Ultra-minimal, precise, purple accent.' },
  { id: 'stripe', name: 'Stripe', description: 'Signature purple gradients, weight-300 elegance.' },
  { id: 'figma', name: 'Figma', description: 'Vibrant multi-color, playful yet professional.' },
  { id: 'bmw-m', name: 'BMW M', description: 'Pure black canvas, M tricolor stripe accents, full-bleed photography.' },
  { id: 'coinbase', name: 'Coinbase', description: 'Clean blue identity, trust-focused, institutional feel.' },
]

// Room for the largest published DESIGN.md (Atlassian's, 81 KB). The whole file
// goes into every model request of the chat, so it stays bounded.
export const DESIGN_MD_MAX_BYTES = 100 * 1024

// What the journal stores for a chat and the agent reads into its instructions.
export interface DesignMdInput {
  name: string
  source: string
  text: string
}

export type DesignMdRequest = { option: DesignMdOption } | { upload: DesignMdInput } | { error: string }

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength

export function checkDesignMdUpload(fileName: unknown, text: unknown): DesignMdInput | { error: string } {
  if (typeof text !== 'string') return { error: 'design.md must be a text file.' }
  const normalized = text.replace(/\r\n?/g, '\n')
  if (normalized.includes('\u0000')) return { error: 'design.md must be a text file.' }
  if (!normalized.trim()) return { error: 'design.md is empty.' }
  if (byteLength(normalized) > DESIGN_MD_MAX_BYTES) return { error: 'design.md must be 100 KB or smaller.' }
  const base = typeof fileName === 'string' ? fileName.split(/[\\/]/).at(-1)?.trim() : ''
  return { name: (base || 'design.md').slice(0, 80), source: 'upload', text: normalized }
}

// A new chat's first prompt names a catalog file by id, or carries an uploaded one.
// Returns null when the prompt carries none.
export function parseDesignMdRequest(value: unknown): DesignMdRequest | null {
  if (value == null) return null
  if (typeof value !== 'object') return { error: 'invalid design.md' }
  const body = value as { id?: unknown; name?: unknown; text?: unknown }
  if (body.id !== undefined) {
    const option = DESIGN_MD_CATALOG.find((candidate) => candidate.id === body.id)
    return option ? { option } : { error: 'unknown design.md' }
  }
  const upload = checkDesignMdUpload(body.name, body.text)
  return 'error' in upload ? upload : { upload }
}
