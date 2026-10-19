import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DESIGN_ARTIFACT_EMBEDDED_CSP, prepareDesignArtifactHtml, validateDesignArtifactHtml } from '../lib/design-artifact.ts'

// Opt-in: runs real Chrome headless on this machine. Set CHROME_PATH for another browser binary.
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// Each design reports where its CSP <meta> landed and whether a script could open a
// nested data: frame, the escape the embedded CSP exists to block.
const PROBE = `<script>
addEventListener('DOMContentLoaded', () => {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
  const report = (frame) => parent.postMessage({ name: document.body.dataset.case, csp: meta ? meta.parentElement.tagName : 'none', frame }, '*')
  addEventListener('securitypolicyviolation', (event) => { if (event.violatedDirective === 'frame-src') report('blocked') })
  const nested = document.createElement('iframe')
  nested.onload = () => report('loaded')
  nested.src = 'data:text/html,<p>nested</p>'
  document.body.append(nested)
})
</script>`
const design = (name) => `<!doctype html><html><head><title>design</title></head><body data-case="${name}"><p>design</p>${PROBE}</body></html>`

// JavaScript trims these, but before a doctype the HTML parser treats them as text.
const NON_HTML_SPACES = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code))
  .filter((character) => /\s/.test(character) && !'\t\n\f\r '.includes(character))
const label = (character) => `U+${character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}`

// Published now: validated, stored as the normalized document, then rendered.
function published(name, raw) {
  const validation = validateDesignArtifactHtml(raw)
  assert.equal(validation.ok, true, `${name}: ${validation.error}`)
  return prepareDesignArtifactHtml(validation.html, DESIGN_ARTIFACT_EMBEDDED_CSP, 'browser-test')
}

function cases() {
  const all = [
    // Control: a design without its CSP must show the nested frame loading, or this test proves nothing.
    ['control without CSP', prepareDesignArtifactHtml(design('control without CSP'), undefined, 'browser-test')],
    ['plain', published('plain', design('plain'))],
  ]
  for (const space of ['\t', '\n', '\f', '\r', ' ', ...NON_HTML_SPACES]) {
    const name = `${label(space)} before the doctype`
    all.push([name, published(name, space + design(name))])
  }
  // Stored before normalization existed: rendered straight from the raw value.
  for (const space of ['\u00a0', '\ufeff']) {
    const name = `stored with ${label(space)} first`
    all.push([name, prepareDesignArtifactHtml(space + design(name), DESIGN_ARTIFACT_EMBEDDED_CSP, 'browser-test')])
  }
  return all
}

const page = (all) => `<!doctype html><html><head><title>design CSP</title></head><body><pre id="out">{}</pre><script>
const results = {}
addEventListener('message', ({ data }) => {
  const seen = results[data.name]
  results[data.name] = { csp: data.csp, frame: seen?.frame === 'blocked' || data.frame === 'blocked' ? 'blocked' : data.frame }
  document.getElementById('out').textContent = JSON.stringify(results)
})
for (const url of ${JSON.stringify(all.map(([, html]) => `data:text/html;base64,${Buffer.from(html).toString('base64')}`))}) {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.src = url
  document.body.append(frame)
}
</script></body></html>`

test('in Chrome, every published or stored design keeps its CSP in <head> and cannot open nested frames', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const all = cases()
  const dir = await mkdtemp(join(tmpdir(), 'fx0-design-csp-'))
  try {
    const file = join(dir, 'page.html')
    await writeFile(file, page(all))
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(file).href,
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    const results = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    for (const [name] of all) {
      const expected = name.startsWith('control') ? { csp: 'none', frame: 'loaded' } : { csp: 'HEAD', frame: 'blocked' }
      assert.deepEqual(results[name], expected, name)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
