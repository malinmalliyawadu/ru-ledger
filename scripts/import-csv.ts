/**
 * Imports a Latitude/Gem statement CSV for the Flight Centre Mastercard, which
 * Akahu cannot connect to.
 *
 *   npm run import:csv -- ~/Downloads/transactions.csv
 *   npm run import:csv -- ~/Downloads/transactions.csv --dry-run
 *
 * The same import is available from the Accounts page in the app, which is the
 * easier route once this is deployed. Both go through src/lib/import-gem.ts.
 */

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { connect } from '../src/lib/db.ts'
import { importGemStatement, prepareGemStatement } from '../src/lib/import-gem.ts'
import { recompute } from '../src/lib/recompute.ts'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const path = args.find((arg) => !arg.startsWith('--'))

if (!path) {
  process.stderr.write('Usage: npm run import:csv -- <file.csv> [--dry-run]\n')
  process.exit(1)
}

const file = resolve(path)
const filename = basename(file)
const text = readFileSync(file, 'utf8')

if (dryRun) {
  const { keyed, from, to } = prepareGemStatement(text, filename)
  log({
    event: 'import.dry_run',
    file: filename,
    rows: keyed.length,
    from,
    to,
    debits: keyed.filter((r) => r.amount < 0).length,
    credits: keyed.filter((r) => r.amount > 0).length,
  })
  process.exit(0)
}

const sql = connect('sync')

try {
  const result = await importGemStatement(sql, { text, filename })
  log({ event: 'import.complete', file: filename, ...result })

  const classified = await recompute(sql)
  log({
    event: 'import.classified',
    transactions: classified.transactions,
    unmatched: classified.unmatched,
    coverage: Number((classified.coverage * 100).toFixed(2)),
  })
} finally {
  await sql.end()
}

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(fields) + '\n')
}
