/**
 * Imports a statement CSV for an account Akahu cannot connect to.
 *
 *   npm run import:csv -- ~/Downloads/statement.csv --account "Rabobank Saver"
 *   npm run import:csv -- ~/Downloads/statement.csv --account "Rabobank Saver" --dry-run
 *
 * The same import is available from the Accounts page in the app, which is the
 * easier route once this is deployed. Both go through
 * src/lib/import-statement.ts, so the natural key is computed in exactly one
 * place — if the two ever disagreed, importing the same file through the other
 * route would duplicate a year of transactions.
 */

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { connect } from '../src/lib/db.ts'
import { importStatementFile, prepareStatement } from '../src/lib/import-statement.ts'
import { recompute } from '../src/lib/recompute.ts'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const path = args.find((arg) => !arg.startsWith('--'))

const accountFlag = args.indexOf('--account')
const accountName = accountFlag >= 0 ? args[accountFlag + 1] : undefined

if (!path || !accountName) {
  process.stderr.write(
    'Usage: npm run import:csv -- <file.csv> --account "Account name" [--dry-run]\n\n' +
      'The account name is what the account is called in the app. Use the same\n' +
      'name every time for the same card, or its history will split in two.\n',
  )
  process.exit(1)
}

const file = resolve(path)
const filename = basename(file)
const text = readFileSync(file, 'utf8')

if (dryRun) {
  const { keyed, externalAccountId, from, to } = prepareStatement(text, filename, accountName)
  log({
    event: 'import.dry_run',
    file: filename,
    account: accountName,
    account_id: externalAccountId,
    rows: keyed.length,
    from,
    to,
    debits: keyed.filter((r) => r.amount < 0).length,
    credits: keyed.filter((r) => r.amount > 0).length,
    // The first few parsed rows, so a column mapped to the wrong thing is
    // visible before anything is written rather than after.
    sample: keyed
      .slice(0, 3)
      .map((r) => ({ date: r.date, description: r.description, amount: r.amount })),
  })
  process.exit(0)
}

const sql = connect('sync')

try {
  const result = await importStatementFile(sql, { text, filename, accountName })
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
