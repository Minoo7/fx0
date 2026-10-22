import { createServer, request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { timingSafeEqual } from 'node:crypto'

const secret = process.env.FX0_PROXY_SECRET ?? await readFile(`${process.env.FX0_SECRETS_DIR ?? '/secrets'}/proxy`, 'utf8')
const upstream = process.env.FX0_UPSTREAM ?? 'http://app:3000'
const authorization = Buffer.from(secret)
createServer((incoming, outgoing) => {
  const url = new URL(incoming.url, 'http://localhost')
  const received = Buffer.from(url.searchParams.get('fx0_proxy_key') ?? '')
  if (received.length !== authorization.length || !timingSafeEqual(received, authorization) ||
    !incoming.headers['x-tsdproxy-username']) {
    outgoing.writeHead(403).end('Tailscale user identity required')
    return
  }
  const headers = { ...incoming.headers, 'x-fx0-proxy-secret': secret,
    'tailscale-user-login': incoming.headers['x-tsdproxy-username'],
    'tailscale-user-name': incoming.headers['x-tsdproxy-displayname'] ?? '',
    'tailscale-user-profile-pic': incoming.headers['x-tsdproxy-profilepicurl'] ?? '',
    'x-forwarded-host': incoming.headers.host, 'x-forwarded-proto': 'https' }
  delete headers.authorization
  url.searchParams.delete('fx0_proxy_key')
  const forwarded = request(upstream, { path: url.pathname + url.search, method: incoming.method, headers }, response => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers)
    response.pipe(outgoing)
  })
  forwarded.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502)
    outgoing.end('fx0 temporarily unavailable')
  })
  outgoing.on('close', () => forwarded.destroy())
  incoming.pipe(forwarded)
}).listen(Number(process.env.FX0_PROXY_PORT ?? 8080), '127.0.0.1')
