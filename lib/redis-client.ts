import { Redis, type Requester } from '@upstash/redis'
import { createClient } from 'redis'

export function createRedis(url: string): Redis {
  const connection = createClient({ url, RESP: 2, socket: { reconnectStrategy: false } })
  connection.on('error', () => console.error('Redis connection failed'))
  let connecting: Promise<unknown> | undefined
  const requester: Requester = {
    async request<T>(request: Parameters<Requester['request']>[0]) {
      if (!connection.isOpen) connecting ??= connection.connect().then(() => connection.unref()).finally(() => { connecting = undefined })
      await connecting
      const command = (args: unknown[]) => args.map(value => String(value))
      if (request.path?.[0] === 'pipeline') {
        const results = await Promise.all((request.body as unknown[][]).map(async args => {
          try { return { result: await connection.sendCommand(command(args)) } }
          catch (error) { return { error: error instanceof Error ? error.message : 'Redis command failed' } }
        }))
        // Upstash's pipeline runtime consumes an array, despite Requester's scalar declaration.
        return results as unknown as { result: T }
      }
      if (request.path?.length) throw new Error('Unsupported Redis transport operation')
      return { result: await connection.sendCommand(command(request.body as unknown[])) as T }
    },
  }
  return new Redis(requester)
}
