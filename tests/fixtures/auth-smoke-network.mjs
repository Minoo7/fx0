// Loaded only in the smoke test's production server. Keep real route/session
// code and the Redis adapter, but replace all outgoing network requests.
const values = new Map()
let releaseSignout
const signoutGate = new Promise(resolve => { releaseSignout = resolve })
process.on('message', message => {
  if (message?.kind === 'release-signout') releaseSignout()
})
globalThis.fetch = async (input, options = {}) => {
  const url = input instanceof Request ? input.url : String(input)
  if (url === 'https://api.vercel.com/login/oauth/token/revoke') {
    return new Response(null, { status: 200 })
  } else if (url === 'https://api.vercel.com/login/oauth/token') {
    const refreshToken = options.body.get('refresh_token')
    if (options.body.get('grant_type') === 'refresh_token') {
      if (refreshToken.startsWith('synthetic-success-')) {
        return Response.json({ access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh', expires_in: 3600 })
      }
      if (refreshToken === 'synthetic-terminal-refresh') return Response.json({ error: 'invalid_grant' }, { status: 400 })
      if (refreshToken === 'synthetic-never-exchanged-refresh-token') return Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
    }
  } else if (new URL(url).origin === 'https://auth-smoke-redis.invalid') {
    const execute = ([command, ...args]) => {
      switch (command.toUpperCase()) {
        case 'GET': return values.get(args[0]) ?? null
        case 'SMEMBERS': return []
        case 'DEL': return args.reduce((count, key) => count + Number(values.delete(key)), 0)
        case 'SET':
          if (args.includes('NX') && values.has(args[0])) return null
          values.set(args[0], args[1])
          return 'OK'
        case 'EVAL': {
          const [, count, ...items] = args
          const keys = items.slice(0, Number(count))
          const [owner, value] = items.slice(Number(count))
          if (values.get(keys[0]) !== owner) return 0
          if (keys.length > 1) values.set(keys[1], value)
          values.delete(keys[0])
          return 1
        }
        default: throw new Error('Unexpected smoke Redis command')
      }
    }
    const body = JSON.parse(options.body)
    const commands = Array.isArray(body[0]) ? body : [body]
    if (process.env.FX0_SMOKE_HOLD_SIGNOUT === '1' && commands.some(([command, key]) => command.toUpperCase() === 'SET' && key.includes(':revoked-login:'))) {
      process.send({ kind: 'signout-held' })
      await signoutGate
    }
    return Response.json(Array.isArray(body[0])
      ? body.map((command) => ({ result: execute(command) })) : { result: execute(body) })
  }
  // The parent checks every stderr event, including requests caught by auth.
  console.error(JSON.stringify({ event: 'smoke:unexpected-network' }))
  throw new Error('External network is disabled in the auth smoke test')
}
