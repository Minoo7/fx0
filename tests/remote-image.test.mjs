import assert from 'node:assert/strict'
import test from 'node:test'
import https from 'node:https'
import dns from 'node:dns/promises'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { BLANK_IMAGE, DESIGN_ARTIFACT_EMBEDDED_CSP, MAX_DESIGN_ARTIFACT_BYTES, remoteImageUrl, rewriteRemoteImages, validateDesignArtifactHtml } from '../lib/design-artifact.ts'
import { embedRemoteImages, loadRemoteImage, MAX_REMOTE_IMAGES, MAX_REMOTE_IMAGES_TOTAL_BYTES } from '../lib/remote-image.ts'
import { sniffImageType } from '../lib/image-sniff.ts'
import { MAX_IMAGE_FETCH_BYTES } from '../lib/public-fetch.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`
const doc = (body, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`

test('only absolute https URLs without credentials are fetchable', () => {
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

test('preparation embeds remote images in every accepted place and nothing else', () => {
  const source = doc(
    '<img src="https://example.com/a.png?x=1&amp;y=2" alt="">' +
    "<img src='https://example.com/b.png'>" +
    '<img src=https://example.com/c.png>' +
    '<img srcset="https://cdn.example.com/w_1,h_1/small.png 1x, https://example.com/large.png 2x">' +
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
  const embedded = []
  const out = rewriteRemoteImages(source, (url) => { embedded.push(url); return PNG_URL })
  assert.deepEqual(embedded.sort(), [
    'https://example.com/a.png?x=1&y=2', 'https://example.com/b.png', 'https://example.com/c.png', 'https://example.com/large.png',
    'https://example.com/a.webp', 'https://example.com/p.png', 'https://example.com/s.png', 'https://example.com/t.png',
    'https://example.com/bg.png', 'https://example.com/bg2.png', 'https://example.com/bg3.png', 'https://example.com/style.png',
    'https://example.com/quoted.png',
  ].sort(), 'a srcset embeds only its largest candidate')
  for (const untouched of ['https://example.com/text.png', 'url(https://example.com/text2.png)', 'href="https://example.com/page"',
    '"https://example.com/script.png"', 'url(https://example.com/script2.png)', 'url(https://example.com/comment.png)',
    '"url(https://example.com/string.png)"', 'url(https://example.com/esc\\61 pe.png)', 'url(http://example.com/plain.png)',
    'src="data:image/gif;base64,R0lGODlhAQABAAAAACw="']) {
    assert.ok(out.includes(untouched), untouched)
  }
  assert.ok(!out.includes('small.png'), 'the smaller srcset candidate is dropped')
  assert.ok(out.includes(`srcset="${PNG_URL}"`))
  assert.ok(out.includes(`background-image: url(${PNG_URL}); color: red`))
  assert.ok(out.includes(`.a { background: url(${PNG_URL}) }`))
})

test('anything but a base64 data: image becomes a blank image, so nothing can break out', () => {
  for (const value of ['https://example.com/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', `${PNG_URL}"><script>`, 'data:image/png;base64,a b']) {
    const out = rewriteRemoteImages(doc('<img src="https://example.com/a.png">', '<style>.a{background:url(https://example.com/b.png)}</style>'), () => value)
    assert.ok(out.includes(`<img src="${BLANK_IMAGE}">`), value)
    assert.ok(out.includes(`url(${BLANK_IMAGE})`), value)
  }
})

test('embedding fetches each image once, in document order, within the count and size budgets', async () => {
  const urls = Array.from({ length: MAX_REMOTE_IMAGES + 2 }, (_, index) => `https://example.com/${index}.png`)
  const html = doc(urls.map((url) => `<img src="${url}">`).join('') + `<img src="${urls[0]}">`)
  const fetched = []
  const result = await embedRemoteImages(html, async (url) => { fetched.push(url); return PNG_URL })
  assert.deepEqual(fetched, urls.slice(0, MAX_REMOTE_IMAGES))
  assert.equal(result.complete, true)
  assert.equal(result.html.split(PNG_URL).length - 1, MAX_REMOTE_IMAGES + 1, 'a repeated image is embedded everywhere it appears')
  assert.equal(result.html.split(BLANK_IMAGE).length - 1, 2, 'images past the count budget are blank')
  assert.ok(!result.html.includes('https://'))

  const big = `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_IMAGE_FETCH_BYTES * 4 / 3) - 8)}`
  const sized = await embedRemoteImages(doc('<img src="https://example.com/1.png"><img src="https://example.com/2.png"><img src="https://example.com/3.png"><img src="https://example.com/4.png">'), async () => big)
  assert.equal(sized.html.split(big).length - 1, 3, 'the total budget stops the fourth large image')
})

test('the size budget counts every place an image is written, so repeating one cannot expand the preview', async () => {
  const big = `data:image/png;base64,${'A'.repeat(Math.ceil(1024 * 1024 * 4 / 3))}`
  const source = doc('<img src="https://example.com/big.png">'.repeat(20) + '<div style="background:url(https://example.com/big.png)"></div>'.repeat(20))
  const result = await embedRemoteImages(source, async () => big)
  assert.equal(result.html.split(big).length - 1, 4, 'four 1 MiB copies fill the 4 MiB budget')
  assert.ok(result.html.length < source.length + MAX_REMOTE_IMAGES_TOTAL_BYTES * 4 / 3 + 40 * BLANK_IMAGE.length)

  const many = doc('<img src="https://example.com/tiny.png">'.repeat(20_000))
  const started = performance.now()
  const tiny = await embedRemoteImages(many, async () => PNG_URL)
  assert.equal(tiny.html.split(PNG_URL).length - 1, 20_000)
  assert.ok(performance.now() - started < 2_000, 'rewriting grows with the output, not with the number of edits')
})

test('preparing a design stays linear in its size, however its CSS is shaped', () => {
  const fill = (unit) => unit.repeat(Math.floor((MAX_DESIGN_ARTIFACT_BYTES - 200) / unit.length))
  for (const [name, html] of [
    ['many style attributes', doc(fill('<b style="a">x</b>'))],
    ['unclosed url( in style attributes', doc(fill('<b style="url(">'))],
    ['unclosed url( in a style block', doc('', `<style>${fill('url(')}</style>`)],
    ['unclosed quoted url( in a style block', doc('', `<style>${fill('url("')}</style>`)],
  ]) {
    assert.equal(validateDesignArtifactHtml(html).ok, true, name)
    const started = performance.now()
    rewriteRemoteImages(html, () => PNG_URL)
    assert.ok(performance.now() - started < 500, `${name}: ${Math.round(performance.now() - started)} ms`)
  }
})

test('a failed image is blank and the copy is marked incomplete; a design without remote images is untouched', async () => {
  const html = doc('<img src="https://example.com/ok.png"><img src="https://example.com/down.png">')
  const result = await embedRemoteImages(html, async (url) => { if (url.endsWith('down.png')) throw new Error('down'); return PNG_URL })
  assert.equal(result.complete, false)
  assert.ok(result.html.includes(`<img src="${PNG_URL}"><img src="${BLANK_IMAGE}">`))
  const plain = doc('<p>no images</p>')
  assert.deepEqual(await embedRemoteImages(plain, async () => { throw new Error('never called') }), { html: plain, complete: true })
})

test('embedded designs need no network: the CSP stays data-only', () => {
  assert.match(DESIGN_ARTIFACT_EMBEDDED_CSP, /img-src data:;/)
  assert.doesNotMatch(DESIGN_ARTIFACT_EMBEDDED_CSP, /https?:/)
})

// The upstream: DNS and https.request are faked, the way tests/public-fetch.test.mjs does.
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

test('a remote image loads as a data: URL typed by its bytes, without cookies or referrer', async (t) => {
  const requests = upstream(t, [{ statusCode: 200, headers: { 'content-type': 'text/html' }, chunks: [PNG] }])
  assert.equal(await loadRemoteImage('https://images.example.com/a.png'), PNG_URL)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://images.example.com/a.png')
  assert.equal(requests[0].options.headers.cookie, undefined)
  assert.equal(requests[0].options.headers.referer, undefined)
})

test('loading refuses private destinations, plain http redirects, non-images, errors and oversized bodies', async (t) => {
  let requests = upstream(t, [], '10.0.0.1')
  await assert.rejects(loadRemoteImage('https://internal.example.com/a.png'))
  assert.equal(requests.length, 0, 'a private address is refused before connecting')
  t.mock.restoreAll()
  requests = upstream(t, [{ statusCode: 302, headers: { location: 'http://images.example.com/a.png' }, chunks: [] }])
  await assert.rejects(loadRemoteImage('https://images.example.com/a.png'), /HTTPS required/)
  assert.equal(requests.length, 1, 'the http hop is never opened')
  t.mock.restoreAll()
  for (const reply of [
    { statusCode: 200, headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')] },
    { statusCode: 200, headers: { 'content-type': 'image/png' }, chunks: [Buffer.from('<!doctype html><script>alert(1)</script>')] },
    { statusCode: 404, headers: {}, chunks: [PNG] },
    { statusCode: 200, headers: { 'content-length': String(MAX_IMAGE_FETCH_BYTES + 1) }, chunks: [] },
    { statusCode: 200, headers: {}, chunks: [PNG, Buffer.alloc(MAX_IMAGE_FETCH_BYTES)] },
  ]) {
    upstream(t, [reply])
    await assert.rejects(loadRemoteImage('https://images.example.com/a.png'))
    t.mock.restoreAll()
  }
})

test('with remote images off, a remote image is refused at publish', (t) => {
  process.env.FX0_REMOTE_IMAGES = '0'
  t.after(() => { delete process.env.FX0_REMOTE_IMAGES })
  assert.equal(validateDesignArtifactHtml(doc('<img src="https://example.com/a.png">')).ok, false)
})
