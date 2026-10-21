import assert from 'node:assert/strict'
import test from 'node:test'
import https from 'node:https'
import dns from 'node:dns/promises'
import { registerHooks } from 'node:module'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.SESSION_SECRET = 'deterministic-remote-image-test-secret-32+'

// Route files import lib modules without an extension, as Next resolves them.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
})

const { signRemoteImage, verifyRemoteImage, remoteImageUrl, REMOTE_IMAGE_PATH } = await import('../lib/remote-image.ts')
const { rewriteRemoteImages, validateDesignArtifactHtml } = await import('../lib/design-artifact.ts')
const { sniffImageType } = await import('../lib/image-sniff.ts')
const route = await import('../app/api/remote-image/[sig]/route.ts')

const ORIGIN = 'https://fx0.example'
const NOW = Date.UTC(2026, 9, 21, 12)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function parts(signed) {
  const url = new URL(signed)
  return { sig: url.pathname.slice(REMOTE_IMAGE_PATH.length), exp: url.searchParams.get('exp'), u: url.searchParams.get('u') }
}

test('a signed URL names one remote image until it expires', () => {
  const image = 'https://images.example.com/a.png?w=100&h=50'
  const signed = signRemoteImage(ORIGIN, image, NOW)
  assert.match(signed, /^https:\/\/fx0\.example\/api\/remote-image\/[A-Za-z0-9_-]{43}\?exp=\d+&u=[A-Za-z0-9\-._~%]+$/)
  const { sig, exp, u } = parts(signed)
  assert.equal(verifyRemoteImage(sig, exp, u, NOW), image)
  // Stable within a day, so the CDN can keep serving one URL.
  assert.equal(signRemoteImage(ORIGIN, image, NOW + 3600_000), signed)
  assert.equal(verifyRemoteImage(sig, exp, 'https://images.example.com/b.png', NOW), null)
  assert.equal(verifyRemoteImage(sig, String(Number(exp) + 86400), u, NOW), null)
  assert.equal(verifyRemoteImage(`${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, exp, u, NOW), null)
  assert.equal(verifyRemoteImage(sig.slice(1), exp, u, NOW), null)
  assert.equal(verifyRemoteImage(sig, exp, u, Number(exp) * 1000 + 1), null)
  assert.equal(verifyRemoteImage(sig, exp, u, NOW - 3 * 86400_000), null, 'too far in the future')
  assert.equal(verifyRemoteImage(sig, null, u, NOW), null)
  assert.equal(verifyRemoteImage(sig, exp, 'https://IMAGES.example.com/a.png?w=100&h=50', NOW), null, 'only the normalized URL')
})

test('only absolute https URLs without credentials are signable', () => {
  assert.equal(remoteImageUrl('https://example.com/a b.png'), 'https://example.com/a%20b.png')
  for (const value of ['http://example.com/a.png', 'https://user:pass@example.com/a.png', '//example.com/a.png', 'https://', `https://example.com/${'a'.repeat(2048)}`]) {
    assert.equal(remoteImageUrl(value), null, value)
  }
})

test('image types come from the bytes', () => {
  assert.equal(sniffImageType(PNG), 'image/png')
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])), 'image/jpeg')
  assert.equal(sniffImageType(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1')), 'image/gif')
  assert.equal(sniffImageType(Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp')
  assert.equal(sniffImageType(Buffer.from('\x00\x00\x00\x1cftypmif1\x00\x00\x00\x00mif1avif', 'latin1')), 'image/avif')
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(sniffImageType(Buffer.from('<!doctype html><script>alert(1)</script>')), null)
  assert.equal(sniffImageType(PNG.subarray(0, 8)), null)
})

const proxy = (url) => `${ORIGIN}${REMOTE_IMAGE_PATH}sig?exp=1&u=${encodeURIComponent(url)}`
const doc = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

test('preparation rewrites remote images in every accepted place and nothing else', () => {
  const source = doc(
    '<img src="https://example.com/a.png?x=1&amp;y=2" alt="">' +
    "<img src='https://example.com/b.png'>" +
    '<img src=https://example.com/c.png>' +
    '<img srcset="https://cdn.example.com/w_1,h_1/a.png 1x, https://example.com/b.png 2x">' +
    '<picture><source srcset="https://example.com/a.webp"></picture>' +
    '<video poster="https://example.com/p.png"></video>' +
    '<svg><image href="https://example.com/s.png"/><image xlink:href="https://example.com/t.png"/></svg>' +
    '<div style="background-image: url(&quot;https://example.com/bg.png&quot;); color: red"></div>' +
    "<div style=\"background: url('https://example.com/bg2.png') no-repeat, url(https://example.com/bg3.png)\"></div>" +
    '<p>https://example.com/text.png url(https://example.com/text2.png)</p>' +
    '<a href="https://example.com/page">link</a>' +
    '<script>const u = "https://example.com/script.png"; const c = "url(https://example.com/script2.png)"</script>' +
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">',
    '<style>.a { background: url(https://example.com/style.png) } /* url(https://example.com/comment.png) */ ' +
    '.b::after { content: "url(https://example.com/string.png)" } .c { background: url("https://example.com/quoted.png") } ' +
    '.d { background: url(https://example.com/esc\\61 pe.png) } .e { background: url(http://example.com/plain.png) }</style>',
  )
  assert.equal(validateDesignArtifactHtml(source).ok, true)
  const out = rewriteRemoteImages(source, proxy)
  for (const name of ['a.png?x=1&y=2', 'b.png', 'c.png', 'w_1,h_1/a.png', 'a.webp', 'p.png', 's.png', 't.png', 'bg.png', 'bg2.png', 'bg3.png', 'style.png', 'quoted.png']) {
    assert.ok(out.includes(encodeURIComponent(`https://${name.startsWith('w_1') ? 'cdn.' : ''}example.com/${name}`)), name)
  }
  for (const untouched of ['https://example.com/text.png', 'url(https://example.com/text2.png)', 'href="https://example.com/page"',
    '"https://example.com/script.png"', 'url(https://example.com/script2.png)', 'url(https://example.com/comment.png)',
    '"url(https://example.com/string.png)"', 'url(https://example.com/esc\\61 pe.png)', 'url(http://example.com/plain.png)',
    'src="data:image/gif;base64,R0lGODlhAQABAAAAACw="']) {
    assert.ok(out.includes(untouched), untouched)
  }
  assert.ok(out.includes('srcset="https://fx0.example/api/remote-image/sig?exp=1&amp;u='), 'srcset values stay attribute-escaped')
  assert.ok(out.includes(' 2x"'), 'srcset descriptors survive')
  assert.ok(out.includes('background-image: url(https://fx0.example/api/remote-image/sig?exp=1&amp;u='), 'style attributes stay attribute-escaped')
  assert.ok(out.includes('url(https://fx0.example/api/remote-image/sig?exp=1&u=https%3A%2F%2Fexample.com%2Fstyle.png)'), '<style> text is raw')
  assert.equal(rewriteRemoteImages(source, proxy), out, 'deterministic')
})

test('a proxy URL cannot break out of the attribute or CSS it lands in', () => {
  const out = rewriteRemoteImages(doc('<img src="https://example.com/a.png">', '<style>.a{background:url(https://example.com/b.png)}</style>'),
    () => `${ORIGIN}/x?u=") '<>( *`)
  const safe = /^[A-Za-z0-9\-._~%&;=?\/:+]+$/
  assert.match(out.match(/<img src="([^"]*)"/)[1], safe)
  assert.match(out.match(/url\(([^)]*)\)/)[1], safe)
})

// The proxy's upstream: DNS and https.request are faked, the way tests/public-fetch.test.mjs does.
const PUBLIC_IP = '93.184.216.34'
function upstream(t, replies, address = PUBLIC_IP) {
  const requests = []
  t.mock.method(dns, 'lookup', async () => [{ address, family: 4 }])
  t.mock.method(https, 'request', (url, options, callback) => {
    const request = new EventEmitter()
    request.end = () => queueMicrotask(() => {
      const reply = replies.shift()
      const response = Readable.from(reply.chunks, { objectMode: false })
      Object.assign(response, { statusCode: reply.statusCode, headers: reply.headers ?? {} })
      callback(response)
    })
    requests.push({ url: url.href, options })
    return request
  })
  return requests
}

async function get(signed, extra = '') {
  const { sig } = parts(signed)
  return route.GET(new Request(`${signed}${extra}`), { params: Promise.resolve({ sig }) })
}

test('the proxy returns a signed remote image as an image that cannot run', async (t) => {
  const requests = upstream(t, [{ statusCode: 200, headers: { 'content-type': 'text/html' }, chunks: [PNG] }])
  const response = await get(signRemoteImage(ORIGIN, 'https://images.example.com/a.png'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png', 'the type comes from the bytes, not the upstream header')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  assert.match(response.headers.get('cache-control'), /^public, .*s-maxage=86400/)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://images.example.com/a.png')
  assert.equal(requests[0].options.headers.cookie, undefined)
  assert.equal(requests[0].options.headers.referer, undefined)
})

async function assertBlank(response) {
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/gif')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.arrayBuffer()).byteLength, 42)
}

test('unsigned, tampered or extended requests get a blank image and never reach upstream', async (t) => {
  const requests = upstream(t, [])
  const signed = signRemoteImage(ORIGIN, 'https://images.example.com/a.png')
  await assertBlank(await get(signed, '&leak=secret'))
  await assertBlank(await get(signed.replace('a.png', 'b.png')))
  await assertBlank(await get(signed.replace(/exp=\d+/, 'exp=9999999999')))
  await assertBlank(await get(`${ORIGIN}${REMOTE_IMAGE_PATH}${'A'.repeat(43)}?exp=1&u=https%3A%2F%2Fexample.com%2Fa.png`))
  assert.equal(requests.length, 0)
})

test('the proxy refuses private destinations, plain http redirects and non-images', async (t) => {
  let requests = upstream(t, [], '10.0.0.1')
  await assertBlank(await get(signRemoteImage(ORIGIN, 'https://internal.example.com/a.png')))
  assert.equal(requests.length, 0, 'a private address is refused before connecting')
  t.mock.restoreAll()
  requests = upstream(t, [{ statusCode: 302, headers: { location: 'http://images.example.com/a.png' }, chunks: [] }])
  await assertBlank(await get(signRemoteImage(ORIGIN, 'https://images.example.com/a.png')))
  assert.equal(requests.length, 1, 'the http hop is never opened')
  t.mock.restoreAll()
  for (const chunks of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')], [Buffer.from('<!doctype html><script>alert(1)</script>')]]) {
    upstream(t, [{ statusCode: 200, headers: { 'content-type': 'image/png' }, chunks }])
    await assertBlank(await get(signRemoteImage(ORIGIN, 'https://images.example.com/a.png')))
    t.mock.restoreAll()
  }
  upstream(t, [{ statusCode: 404, headers: {}, chunks: [PNG] }])
  await assertBlank(await get(signRemoteImage(ORIGIN, 'https://images.example.com/a.png')))
})

test('with remote images off, the proxy serves nothing', async (t) => {
  const requests = upstream(t, [{ statusCode: 200, headers: {}, chunks: [PNG] }])
  process.env.FX0_REMOTE_IMAGES = '0'
  t.after(() => { delete process.env.FX0_REMOTE_IMAGES })
  await assertBlank(await get(signRemoteImage(ORIGIN, 'https://images.example.com/a.png')))
  assert.equal(requests.length, 0)
  assert.equal(validateDesignArtifactHtml(doc('<img src="https://example.com/a.png">')).ok, false)
})
