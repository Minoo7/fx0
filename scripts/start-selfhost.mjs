import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const directory = process.env.FX0_SECRETS_DIR ?? '/secrets'
const read = name => readFile(join(directory, name), 'utf8')
const [database, session, proxy, redis] = await Promise.all(['database', 'session', 'proxy', 'redis'].map(read))
process.env.DATABASE_URL ??= `postgresql://fx0:${database}@postgres:5432/fx0`
process.env.SESSION_SECRET = session
process.env.FX0_PROXY_SECRET = proxy
process.env.REDIS_URL ??= `redis://:${redis}@redis:6379`
process.env.FX0_DATA_DIR ??= '/data'
const migrate = spawn(process.execPath, ['scripts/migrate-database.mjs'], { stdio: 'inherit' })
const code = await new Promise(resolve => migrate.on('exit', resolve))
if (code !== 0) process.exit(1)
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '0.0.0.0'], { stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill(signal))
server.on('exit', code => process.exit(code ?? 1))
