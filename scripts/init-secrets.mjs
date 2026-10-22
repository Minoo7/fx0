import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.env.FX0_SECRETS_DIR ?? '/secrets'
await mkdir(directory, { recursive: true, mode: 0o700 })
async function secret(name) {
  const path = join(directory, name)
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const value = randomBytes(32).toString('hex')
    await writeFile(path, value, { mode: 0o600, flag: 'wx' })
    return value
  }
}
await Promise.all(['database', 'session', 'proxy'].map(secret))
const redis = await secret('redis')
await writeFile(join(directory, 'redis.conf'), `appendonly yes\nrequirepass ${redis}\n`, { mode: 0o600 })
await writeFile(join(directory, 'serve.json'), JSON.stringify({
  TCP: { 443: { HTTPS: true } },
  Web: { '${TS_CERT_DOMAIN}:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } },
  AllowFunnel: {},
}), { mode: 0o644 })
console.log('fx0 private runtime configuration ready')
