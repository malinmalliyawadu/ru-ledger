/**
 * Migration runner. Applies db/migrations/*.sql in filename order, once each,
 * inside a transaction, recording what ran in schema_migrations.
 *
 *   npm run db:migrate          apply anything outstanding
 *   npm run db:reset            drop the public schema and rebuild from zero
 *
 * Deliberately about sixty lines rather than a dependency: the whole contract
 * is "run these files in order, once".
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connect } from '../src/lib/db.ts'

const migrationsDir = fileURLToPath(new URL('../db/migrations', import.meta.url))
const reset = process.argv.includes('--reset')
const sql = connect()

try {
  if (reset) {
    log({ event: 'migrate.reset', note: 'dropping schema public' })
    await sql.unsafe('drop schema if exists public cascade; create schema public;')
  }

  await sql`
    create table if not exists schema_migrations (
      version    text primary key,
      applied_at timestamptz not null default now(),
      checksum   text not null
    )
  `

  const applied = new Map(
    (
      await sql<{ version: string; checksum: string }[]>`
        select version, checksum from schema_migrations
      `
    ).map((row) => [row.version, row.checksum]),
  )

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  let ran = 0

  for (const file of files) {
    const version = file.replace(/\.sql$/, '')
    const body = readFileSync(`${migrationsDir}/${file}`, 'utf8')
    const checksum = await digest(body)
    const previous = applied.get(version)

    if (previous !== undefined) {
      // A migration that changed after being applied means the database and the
      // repo disagree about history. Refuse rather than guess.
      if (previous !== checksum) {
        throw new Error(
          `${file} has changed since it was applied. Write a new migration instead of editing an applied one.`,
        )
      }
      continue
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`
        insert into schema_migrations (version, checksum)
        values (${version}, ${checksum})
      `
    })

    log({ event: 'migrate.applied', version })
    ran += 1
  }

  log({ event: 'migrate.complete', applied: ran, total: files.length })
} finally {
  await sql.end()
}

async function digest(body: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(fields) + '\n')
}
