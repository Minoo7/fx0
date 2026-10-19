export const MAX_DESIGN_ARTIFACT_BYTES = 512 * 1024

export const DESIGN_ARTIFACT_EMBEDDED_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  'media-src data:',
  "connect-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function designArtifactBootstrap(readyToken?: string): string {
  // The sandbox grants no popups, so a clicked https link asks the trusted wrapper to
  // open it (see app/api/artifact-frame) instead of navigating the preview away.
  const heartbeat = readyToken
    ? `const token=${JSON.stringify(readyToken)};const send=type=>parent.postMessage({type,token},"*");send("heartbeat");setInterval(()=>send("heartbeat"),500);addEventListener("load",()=>{send("ready");requestAnimationFrame(()=>requestAnimationFrame(()=>send("painted")))},{once:true});addEventListener("click",event=>{const link=event.target instanceof Element&&event.target.closest("a[href]");const url=link?link.getAttribute("href")||"":"";if(/^https:/i.test(url)){event.preventDefault();parent.postMessage({type:"open",token,url},"*")}},true);`
    : ''
  return `<script>(()=>{for(const name of ["RTCPeerConnection","webkitRTCPeerConnection","RTCIceGatherer"]){try{Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false})}catch{}}${heartbeat}})()</script>`
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function prepareDesignArtifactHtml(html: string, embeddedCsp?: string, readyToken?: string): string {
  const csp = embeddedCsp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(embeddedCsp)}">`
    : ''
  return html.replace(/^(\s*<!doctype\s+html\s*>)/i, `$1${csp}${designArtifactBootstrap(readyToken)}`)
}

export type DesignArtifactValidation = { ok: true; bytes: number } | { ok: false; error: string }

interface HtmlTag {
  name: string
  attributes: Map<string, string>
  duplicateAttribute: string | null
}

const PROHIBITED_TAGS = new Map([
  ['base', '<base> elements'],
  ['form', 'forms'],
  ['iframe', '<iframe> elements'],
  ['object', '<object> elements'],
  ['embed', '<embed> elements'],
])

function findTagEnd(source: string, start: number): number {
  let quote = ''
  for (let index = start; index < source.length; index++) {
    const character = source[index]
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

function parseAttributes(source: string): Pick<HtmlTag, 'attributes' | 'duplicateAttribute'> {
  const attributes = new Map<string, string>()
  let duplicateAttribute: string | null = null
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase()
    if (name === '/') continue
    if (attributes.has(name)) {
      duplicateAttribute ??= name
      continue
    }
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return { attributes, duplicateAttribute }
}

function parseOpeningTags(source: string): HtmlTag[] {
  const tags: HtmlTag[] = []
  const normalized = source.toLowerCase()
  let cursor = 0
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor)
    if (start < 0) break
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4)
      cursor = end < 0 ? source.length : end + 3
      continue
    }
    const marker = source[start + 1]
    if (!marker || marker === '/' || marker === '!' || marker === '?') {
      cursor = start + 2
      continue
    }
    const nameMatch = source.slice(start + 1).match(/^([a-z][a-z0-9:-]*)/i)
    if (!nameMatch) {
      cursor = start + 1
      continue
    }
    const end = findTagEnd(source, start + 1 + nameMatch[0].length)
    if (end < 0) break
    const name = nameMatch[1].toLowerCase()
    const attributeSource = source.slice(start + 1 + nameMatch[0].length, end)
    tags.push({ name, ...parseAttributes(attributeSource) })
    if (name === 'script' || name === 'style') {
      const closing = normalized.indexOf(`</${name}`, end + 1)
      cursor = closing < 0 ? source.length : closing
    } else {
      cursor = end + 1
    }
  }
  return tags
}

function decodeCodePoint(digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix)
  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd'
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, digits: string) => decodeCodePoint(digits, 16))
    .replace(/&#([0-9]+);?/g, (_, digits: string) => decodeCodePoint(digits, 10))
    .replace(/&(colon|tab|newline|amp);?/gi, (_, entity: string) => {
      const decoded: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', amp: '&' }
      return decoded[entity.toLowerCase()]
    })
    .trim()
}

function compactUrlScheme(value: string): string {
  return decodeAttribute(value)
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .toLowerCase()
}

function isEmbeddedSource(tag: string, value: string): boolean {
  const decoded = decodeAttribute(value)
  if (tag === 'img' || tag === 'input') return /^data:image\//i.test(decoded)
  if (tag === 'audio') return /^data:audio\//i.test(decoded)
  if (tag === 'video') return /^data:video\//i.test(decoded)
  if (tag === 'track') return /^data:text\/vtt(?:[;,]|$)/i.test(decoded)
  if (tag === 'source') return /^data:(?:image|audio|video)\//i.test(decoded)
  return false
}

function isEmbeddedSrcset(tag: string, value: string): boolean {
  if (tag !== 'img' && tag !== 'source') return false
  const decoded = decodeAttribute(value)
  const comma = decoded.indexOf(',')
  if (comma < 0 || decoded.indexOf(',', comma + 1) >= 0) return false
  const metadata = decoded.slice(0, comma)
  const payload = decoded.slice(comma + 1)
  return /^data:image\/[a-z0-9.+-]+(?:;[^,\s]*)*$/i.test(metadata) && /^\S+(?:\s+(?:\d+(?:\.\d+)?[wx]))?$/.test(payload)
}

function validateTag(tag: HtmlTag): string | null {
  if (tag.duplicateAttribute) {
    return `design artifact must not repeat the ${tag.duplicateAttribute} attribute`
  }

  const prohibited = PROHIBITED_TAGS.get(tag.name)
  if (prohibited) return `design artifact must not contain ${prohibited}`
  if (tag.name === 'script' && tag.attributes.has('src')) {
    return 'design artifact scripts must be inline'
  }

  if (tag.name === 'meta' && decodeAttribute(tag.attributes.get('http-equiv') ?? '').toLowerCase() === 'refresh') {
    return 'design artifact must not contain meta refresh'
  }

  for (const [name, rawValue] of tag.attributes) {
    const compactValue = compactUrlScheme(rawValue)
    if (compactValue.startsWith('javascript:') || compactValue.startsWith('vbscript:')) {
      return 'design artifact must not use scripted URLs'
    }

    if (name === 'action' || name === 'formaction') {
      return `design artifact must not contain ${name} attributes`
    }
    if (name === 'href' || name === 'xlink:href') {
      const value = decodeAttribute(rawValue)
      const isSafeSvgImage = tag.name === 'image' && /^data:image\//i.test(value)
      // Links to https pages (cited sources, references) open in a new tab; see the bootstrap.
      const isExternalLink = tag.name === 'a' && name === 'href' && /^https:\/\/[^\s]+$/i.test(value)
      if (!value.startsWith('#') && !isSafeSvgImage && !isExternalLink) {
        return `design artifact ${name} values must be local fragments, https links, or compatible embedded data: URLs`
      }
    }
    if (name === 'src' && !isEmbeddedSource(tag.name, rawValue)) {
      return 'design artifact src values must use a compatible embedded data: URL'
    }
    if (name === 'srcset' && !isEmbeddedSrcset(tag.name, rawValue)) {
      return 'design artifact srcset values must contain one embedded data:image URL'
    }
    if (name === 'poster' && !/^data:image\//i.test(decodeAttribute(rawValue))) {
      return 'design artifact poster values must use an embedded data:image URL'
    }
  }

  return null
}

export function validateDesignArtifactHtml(html: string): DesignArtifactValidation {
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > MAX_DESIGN_ARTIFACT_BYTES) {
    return { ok: false, error: 'design artifact exceeds 512 KiB' }
  }

  const source = html.trim()
  if (source.includes('<!--')) {
    return { ok: false, error: 'design artifact must not contain HTML comments' }
  }
  if (!/^<!doctype\s+html\s*>/i.test(source)) {
    return { ok: false, error: 'design artifact must start with <!doctype html>' }
  }
  const afterDoctype = source.replace(/^<!doctype\s+html\s*>/i, '')
  if (/<(?:!|\?)/.test(afterDoctype)) {
    return { ok: false, error: 'design artifact must not contain markup declarations' }
  }

  const requiredTags = ['html', 'head', 'body'] as const
  for (const tag of requiredTags) {
    const openings = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi'))?.length ?? 0
    const closings = source.match(new RegExp(`</${tag}\\s*>`, 'gi'))?.length ?? 0
    if (openings !== 1 || closings !== 1) {
      return { ok: false, error: `design artifact must contain exactly one <${tag}> element` }
    }
  }

  if (
    !/<html(?:\s[^>]*)?>[\s\S]*<head(?:\s[^>]*)?>[\s\S]*<\/head\s*>[\s\S]*<body(?:\s[^>]*)?>[\s\S]*<\/body\s*>[\s\S]*<\/html\s*>\s*$/i.test(
      source,
    )
  ) {
    return { ok: false, error: 'design artifact must be one complete html document with head and body' }
  }

  for (const tag of parseOpeningTags(source)) {
    const error = validateTag(tag)
    if (error) return { ok: false, error }
  }

  return { ok: true, bytes }
}
