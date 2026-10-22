import { createServer, request } from 'node:http'
import { readFile } from 'node:fs/promises'

const secret = process.env.FX0_PROXY_SECRET ?? await readFile(`${process.env.FX0_SECRETS_DIR ?? '/secrets'}/proxy`, 'utf8')
const upstream = process.env.FX0_UPSTREAM ?? 'http://app:3000'
createServer((incoming, outgoing) => {
  if (!incoming.headers['tailscale-user-login']) {
    outgoing.writeHead(403).end('Tailscale user identity required')
    return
  }
  const headers = { ...incoming.headers, 'x-fx0-proxy-secret': secret,
    'x-forwarded-host': incoming.headers.host, 'x-forwarded-proto': 'https' }
  const forwarded = request(upstream, { path: incoming.url, method: incoming.method, headers }, response => {
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
