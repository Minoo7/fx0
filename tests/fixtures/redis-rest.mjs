import { once } from 'node:events'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'

// A stand-in for Upstash's REST API in front of a local redis-server, so a test can
// run the real journal code, its Lua included, against real Redis. It answers the
// way @upstash/redis expects: `{ result }` per command, base64 strings when asked.
export async function redisRest(socketPath) {
  const connection = createConnection(socketPath)
  await once(connection, 'connect')
  let buffer = Buffer.alloc(0)
  const waiting = []
  connection.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (let parsed = parse(buffer, 0); parsed && waiting.length; parsed = parse(buffer, 0)) {
      buffer = buffer.subarray(parsed.next)
      waiting.shift()(parsed.value)
    }
  })
  const send = (args) => new Promise((resolve) => {
    waiting.push(resolve)
    const parts = args.map((arg) => Buffer.from(String(arg)))
    connection.write(Buffer.concat([
      Buffer.from(`*${parts.length}\r\n`),
      ...parts.flatMap((part) => [Buffer.from(`$${part.length}\r\n`), part, Buffer.from('\r\n')]),
    ]))
  })

  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const base64 = request.headers['upstash-encoding'] === 'base64'
    const reply = (value) => value?.error ? { error: value.error } : { result: base64 ? encode(value) : value }
    const commands = JSON.parse(body)
    const pipelined = request.url.endsWith('/pipeline') || request.url.endsWith('/multi-exec')
    const results = []
    for (const command of pipelined ? commands : [commands]) results.push(reply(await send(command)))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(pipelined ? results : results[0]))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      connection.end()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const encode = (value) => typeof value === 'string' ? Buffer.from(value).toString('base64')
  : Array.isArray(value) ? value.map(encode) : value

// One RESP2 reply from `buffer` at `offset`, or null until it has all arrived.
function parse(buffer, offset) {
  const end = buffer.indexOf('\r\n', offset)
  if (end < 0) return null
  const kind = String.fromCharCode(buffer[offset])
  const line = buffer.toString('utf8', offset + 1, end)
  if (kind === '+') return { value: line, next: end + 2 }
  if (kind === '-') return { value: { error: line }, next: end + 2 }
  if (kind === ':') return { value: Number(line), next: end + 2 }
  if (kind === '$') {
    const length = Number(line)
    if (length < 0) return { value: null, next: end + 2 }
    if (buffer.length < end + 2 + length + 2) return null
    return { value: buffer.toString('utf8', end + 2, end + 2 + length), next: end + 2 + length + 2 }
  }
  if (kind === '*') {
    const count = Number(line)
    if (count < 0) return { value: null, next: end + 2 }
    const values = []
    let next = end + 2
    for (let index = 0; index < count; index++) {
      const item = parse(buffer, next)
      if (!item) return null
      values.push(item.value)
      next = item.next
    }
    return { value: values, next }
  }
  throw new Error(`unexpected RESP reply ${JSON.stringify(kind)}`)
}
