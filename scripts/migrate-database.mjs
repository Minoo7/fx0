import { readdir, readFile } from 'node:fs/promises'
import { Client } from 'pg'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const directory = new URL('../migrations/', import.meta.url)
const files = (await readdir(directory)).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort()
const sql = new Client({ connectionString: process.env.DATABASE_URL })
await sql.connect()
for (const file of files) {
  try {
    const migration = await readFile(new URL(file, directory), 'utf8')
    // Every statement is idempotent, so reapplying earlier files is safe.
    const statements = migration.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')
      .split(';').map((text) => text.trim()).filter(Boolean)
    await sql.query('BEGIN')
    for (const text of statements) await sql.query(text)
    await sql.query('COMMIT')
    console.log(`${file} applied`)
  } catch {
    await sql.query('ROLLBACK')
    console.error(`${file} failed; verify DATABASE_URL and database permissions`)
    process.exitCode = 1
    break
  }
}
await sql.end()
