/**
 * The daily sync. Run by Coolify as a scheduled task inside the app image:
 *
 *   node scripts/sync.ts
 *
 * Not an HTTP endpoint. There is nothing public to trigger, no shared secret to
 * leak, and a failure shows up as a failed task rather than as a 500 nobody
 * reads.
 *
 * Deliberately re-fetches an overlapping window rather than resuming from the
 * last transaction seen. Akahu's `start` is exclusive, banks post transactions
 * days late, and a card can revise a pending amount after the fact — so
 * resuming exactly where the last run stopped silently drops rows. The upsert
 * is idempotent, which makes the overlap free.
 *
 *   --days N     how far back to re-fetch (default 14)
 *   --refresh    ask Akahu to pull fresh data from the banks first
 *   --trigger X  label for the sync_runs row (default 'cron')
 */

import { createAkahuClient } from '../src/lib/akahu.ts'
import { connect } from '../src/lib/db.ts'
import { countRevised, countTransactions, upsertAccount, writeTransactions } from '../src/lib/ingest.ts'
import { recompute } from '../src/lib/recompute.ts'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}

const days = Number(flag('days', '14'))
const trigger = flag('trigger', 'cron')
const shouldRefresh = args.includes('--refresh')

// A Personal App refresh is asynchronous: Akahu goes off to the banks and the
// data lands some time later. Waiting lets this run see it instead of picking
// it up tomorrow.
const REFRESH_SETTLE_MS = 90_000

if (!Number.isFinite(days) || days <= 0) {
  process.stderr.write('--days must be a positive number\n')
  process.exit(1)
}

const end = new Date()
const start = new Date(end.getTime() - days * 86_400_000)

const akahu = createAkahuClient()
const sql = connect('sync')

let runId: string | null = null

try {
  const [run] = await sql<{ id: string }[]>`
    insert into sync_runs (trigger, status, details)
    values (${trigger}, 'running', ${sql.json({ window_days: days, refreshed: shouldRefresh })})
    returning id
  `
  runId = run!.id

  if (shouldRefresh) {
    // A refresh is an optimisation, not a prerequisite. Akahu refreshes every
    // account daily on its own schedule, so failing to get a fresher pull is a
    // reason to log and carry on, never a reason to abandon the sync.
    try {
      await akahu.refresh()
      log({ event: 'sync.refresh_requested', settling_ms: REFRESH_SETTLE_MS })
      await new Promise((resolve) => setTimeout(resolve, REFRESH_SETTLE_MS))
    } catch (error) {
      log({
        event: 'sync.refresh_unavailable',
        error: String(error),
        note: 'continuing with whatever Akahu last pulled',
      })
    }
  }

  const accounts = await akahu.accounts()

  let fetched = 0
  let inserted = 0
  let revised = 0
  const failures: { account: string; error: string }[] = []

  for (const account of accounts) {
    const label = `${account.connection?.name ?? '?'} / ${account.name}`

    // One unreachable bank connection must not abandon the other seven.
    try {
      const accountId = await upsertAccount(sql, account)
      const beforeCount = await countTransactions(sql, accountId)
      const beforeRevised = await countRevised(sql, accountId)

      for await (const page of akahu.transactions(account._id, { start, end })) {
        fetched += page.length
        await writeTransactions(sql, accountId, page)
      }

      const newRows = (await countTransactions(sql, accountId)) - beforeCount
      const revisedRows = (await countRevised(sql, accountId)) - beforeRevised

      inserted += newRows
      revised += revisedRows

      await sql`update accounts set last_synced_at = now() where id = ${accountId}`

      log({ event: 'sync.account', account: label, new: newRows, revised: revisedRows })
    } catch (error) {
      failures.push({ account: label, error: String(error) })
      log({ event: 'sync.account_failed', account: label, error: String(error) })
    }
  }

  // Always reclassify. New rows arriving unclassified would understate every
  // figure on the dashboard until someone happened to run a recompute.
  const classified = await recompute(sql)

  // A source that stops arriving does not fail, it just goes quiet — and for
  // the CSV card that silently understates spending, because the Kiwibank
  // payment settling it is still excluded.
  const stale = await sql<
    { name: string; source: string; days_since_transaction: number | null; days_since_sync: number | null }[]
  >`
    select name, source, days_since_transaction, days_since_sync
    from account_health where is_stale
  `
  for (const account of stale) {
    log({
      event: 'sync.stale_account',
      account: account.name,
      source: account.source,
      days_since_transaction: account.days_since_transaction,
      days_since_sync: account.days_since_sync,
      note:
        account.source === 'csv'
          ? 'export a fresh statement and run import:csv, or spending is understated'
          : 'this account has not been reached by a sync recently',
    })
  }

  const status = failures.length === 0 ? 'success' : 'partial'

  await sql`
    update sync_runs set
      status               = ${status},
      finished_at          = now(),
      accounts_synced      = ${accounts.length - failures.length},
      transactions_fetched = ${fetched},
      transactions_new     = ${inserted},
      transactions_revised = ${revised},
      uncategorised_count  = ${classified.unmatched},
      error                = ${failures.length > 0 ? JSON.stringify(failures) : null},
      details              = ${sql.json({
        window_days: days,
        refreshed: shouldRefresh,
        coverage: Number((classified.coverage * 100).toFixed(2)),
        stale_accounts: stale.map((a) => a.name),
      })}
    where id = ${runId}
  `

  log({
    event: 'sync.complete',
    status,
    accounts: accounts.length,
    failed_accounts: failures.length,
    fetched,
    new: inserted,
    revised,
    uncategorised: classified.unmatched,
    coverage: Number((classified.coverage * 100).toFixed(2)),
    stale_accounts: stale.length,
  })

  // A partial sync is a real problem: it means a bank connection needs
  // reauthorising. Exit non-zero so the scheduler reports it.
  if (failures.length > 0) process.exitCode = 1
} catch (error) {
  if (runId) {
    await sql`
      update sync_runs set status = 'failed', finished_at = now(), error = ${String(error)}
      where id = ${runId}
    `
  }
  log({ event: 'sync.failed', error: String(error) })
  process.exitCode = 1
} finally {
  await sql.end()
}

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...fields }) + '\n')
}
