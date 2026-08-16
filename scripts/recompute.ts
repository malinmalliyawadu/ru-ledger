/**
 * Rebuilds transactions_enriched from transactions_raw + rules + aliases.
 * Fetches nothing, so it is safe to run as often as the rules change.
 *
 *   npm run recompute
 */

import { connect } from '../src/lib/db.ts'
import { recompute } from '../src/lib/recompute.ts'

const sql = connect('sync')

try {
  const result = await recompute(sql)

  log({
    event: 'recompute.complete',
    transactions: result.transactions,
    rules: result.rules,
    unmatched: result.unmatched,
    coverage: Number((result.coverage * 100).toFixed(2)),
    recurring_series: result.recurringSeries,
    large_purchases: result.largePurchases,
    threshold: result.threshold,
  })

  for (const description of result.unmatchedSamples) {
    log({ event: 'recompute.unmatched', description })
  }
} finally {
  await sql.end()
}

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(fields) + '\n')
}
