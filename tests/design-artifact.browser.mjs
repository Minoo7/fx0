import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DESIGN_ARTIFACT_EMBEDDED_CSP, DESIGN_FRAME_CSP, designArtifactEmbeddedCsp, designFrameCsp, prepareDesignArtifactHtml, validateDesignArtifactHtml } from '../lib/design-artifact.ts'

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

// The wrapper's own policy reaches the design's data: frame, so a design is rendered
// here under both policies, as in production. An embedded image must load; a remote
// one must still be refused by the policy, not merely fail to connect.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const imageDesign = `<!doctype html><html><head><title>design</title></head><body>
<img id="embedded" alt="" src="data:image/png;base64,${PIXEL}">
<script>
const results = {}
const report = (name, value) => { results[name] ??= value; parent.postMessage(results, '*') }
addEventListener('securitypolicyviolation', (event) => {
  if (event.blockedURI.startsWith('data:')) report('embedded', 'blocked')
  if (event.blockedURI.startsWith('http:')) report('remote', 'blocked')
})
const embedded = document.getElementById('embedded')
embedded.complete && embedded.naturalWidth ? report('embedded', 'loaded') : embedded.addEventListener('load', () => report('embedded', 'loaded'))
const remote = new Image()
remote.onload = () => report('remote', 'loaded')
remote.src = 'http://127.0.0.1:9/pixel.png'
</script></body></html>`

test('in Chrome, a published design shows embedded images inside the wrapper and still refuses remote ones', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const dir = await mkdtemp(join(tmpdir(), 'fx0-design-frame-csp-'))
  try {
    const url = `data:text/html;base64,${Buffer.from(published('image', imageDesign)).toString('base64')}`
    const frameCsp = DESIGN_FRAME_CSP.replace(/; frame-ancestors[^;]*/, '')
    const file = join(dir, 'page.html')
    await writeFile(file, `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${frameCsp}"><title>frame CSP</title></head><body><pre id="out">{}</pre><script>
addEventListener('message', ({ data }) => { if (!data.token) document.getElementById('out').textContent = JSON.stringify(data) })
const frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts')
frame.setAttribute('credentialless', '')
frame.src = ${JSON.stringify(url)}
document.body.append(frame)
</script></body></html>`)
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--virtual-time-budget=5000', '--dump-dom', pathToFileURL(file).href,
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    const results = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    assert.deepEqual(results, { embedded: 'loaded', remote: 'blocked' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Remote images under both policies, served the way production serves them: the wrapper's
// policy as a response header, the design as a data: frame. Only absolute URLs under the
// proxy path load; a relative one cannot resolve in a data: document, and a script cannot
// reach any other address. A proxy image that never arrives holds "painted" only briefly.
test('in Chrome, a design loads images only from absolute proxy URLs, and a stuck image does not hold the preview', async () => {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}; set CHROME_PATH`)
  const dir = await mkdtemp(join(tmpdir(), 'fx0-remote-image-csp-'))
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const sources = [`${origin}/api/remote-image/`]
  const design = (body) => {
    const html = prepareDesignArtifactHtml(`<!doctype html><html><head><title>design</title></head><body>${body}</body></html>`, designArtifactEmbeddedCsp(sources), 'browser-test')
    return `data:text/html;base64,${Buffer.from(html).toString('base64')}`
  }
  const images = design(`<img id="proxy" alt="" src="${origin}/api/remote-image/ok"><img id="relative" alt="" src="/api/remote-image/ok">
<script>
const results = {}
const report = (name, value) => { results[name] ??= value; parent.postMessage({ results }, '*') }
addEventListener('securitypolicyviolation', (event) => {
  if (event.blockedURI.includes('/other.png')) report('script', 'blocked')
  if (event.blockedURI.startsWith('https://example.com')) report('direct', 'blocked')
})
for (const id of ['proxy', 'relative']) {
  const image = document.getElementById(id)
  if (image.complete) report(id, image.naturalWidth ? 'loaded' : 'failed')
  image.addEventListener('load', () => report(id, 'loaded'))
  image.addEventListener('error', () => report(id, 'failed'))
}
const leak = new Image(); leak.onload = () => report('script', 'loaded'); leak.src = '${origin}/other.png?d=' + document.title
const direct = new Image(); direct.onload = () => report('direct', 'loaded'); direct.src = 'https://example.com/a.png'
</script>`)
  const stuck = design(`<img alt="" src="${origin}/api/remote-image/stuck">`)
  server.on('request', (request, response) => {
    const pixel = Buffer.from(PIXEL, 'base64')
    if (request.url === '/api/remote-image/ok' || request.url.startsWith('/other.png')) {
      response.writeHead(200, { 'content-type': 'image/png' }).end(pixel)
    } else if (request.url === '/api/remote-image/stuck') {
      // Never answers: the image neither loads nor fails while the test runs.
    } else if (request.url === '/frame') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': designFrameCsp(sources) }).end(`<!doctype html><html><head><title>frame</title></head><body><pre id="out">{}</pre><script>
const out = { painted: [] }
const started = performance.now()
addEventListener('message', ({ data, source }) => {
  if (data.results) out.images = data.results
  if (data.type === 'painted') out.painted.push({ frame: source === frames[0] ? 'images' : 'stuck', ms: Math.round(performance.now() - started) })
  document.getElementById('out').textContent = JSON.stringify(out)
})
for (const url of ${JSON.stringify([images, stuck])}) {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.setAttribute('credentialless', '')
  frame.src = url
  document.body.append(frame)
}
</script></body></html>`)
    } else {
      response.writeHead(404).end()
    }
  })
  try {
    const { stdout } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(dir, 'profile')}`, '--timeout=4000', '--dump-dom', `${origin}/frame`,
    ], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
    const out = JSON.parse(stdout.match(/<pre id="out">([^<]*)<\/pre>/)[1])
    assert.deepEqual(out.images, { proxy: 'loaded', relative: 'failed', script: 'blocked', direct: 'blocked' })
    const stuckPaint = out.painted.find((paint) => paint.frame === 'stuck')
    assert.ok(stuckPaint, 'a stuck image must not keep the design from reporting painted')
    assert.ok(stuckPaint.ms < 3000, `painted after ${stuckPaint.ms} ms`)
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
