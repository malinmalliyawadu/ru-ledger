/**
 * Initial backfill. Pulls every account Akahu can reach and pages back as far
 * as the API will go.
 *
 *   npm run backfill              -- two years, the most any NZ bank offers
 *   npm run backfill -- --years 1
 *   npm run backfill -- --dry-run
 *
 * Reports how far back each account ACTUALLY returned against what was asked
 * for, because the two differ and the difference is per-account and silent.
 * Kiwibank caps credit card history at 180 days on a first connection, so the
 * honest answer for that account is "we asked for two years and got six
 * months", and that needs to be on the record rather than discovered later when
 * a chart looks short.
 *
 * Idempotent: rows upsert on (source, external_id), and an existing row is only
 * touched when Akahu's payload genuinely changed, which stamps revised_at.
 */

import { createAkahuClient } from '../src/lib/akahu.ts'
import { connect } from '../src/lib/db.ts'
import { countRevised, countTransactions, upsertAccount, writeTransactions } from '../src/lib/ingest.ts'
import { nzDate } from '../src/lib/time.ts'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const yearsArg = args.indexOf('--years')
const years = yearsArg >= 0 ? Number(args[yearsArg + 1]) : 2

if (!Number.isFinite(years) || years <= 0) {
  process.stderr.write('--years must be a positive number\n')
  process.exit(1)
}

const end = new Date()
const start = new Date(end)
start.setUTCFullYear(start.getUTCFullYear() - years)

const akahu = createAkahuClient()
const sql = connect('sync')

let runId: string | null = null

try {
  const identity = await akahu.me()
  log({ event: 'backfill.authenticated', akahu_user: identity._id ?? '(unknown)' })

  const accounts = await akahu.accounts()
  log({
    event: 'backfill.accounts',
    count: accounts.length,
    accounts: accounts.map((a) => `${a.connection?.name ?? '?'} / ${a.name}`),
    requested_from: iso(start),
    requested_to: iso(end),
  })

  if (dryRun) {
    process.exit(0)
  }

  const [run] = await sql<{ id: string }[]>`
    insert into sync_runs (trigger, status, details)
    values ('backfill', 'running', ${sql.json({ requested_from: iso(start), requested_to: iso(end) })})
    returning id
  `
  runId = run!.id

  let totalFetched = 0
  let totalNew = 0
  let totalRevised = 0

  // A type alias rather than Record<string, unknown>, so it satisfies
  // postgres.js's JSONValue and can be stored on the sync run as-is.
  type AccountReport = {
    event: string
    account: string
    type: string | null
    requested_from: string
    oldest_returned: string | null
    newest_returned: string | null
    days_short_of_request: number | null
    fetched: number
    inserted: number
    revised: number
  }
  const report: AccountReport[] = []

  for (const account of accounts) {
    const accountId = await upsertAccount(sql, account)
    const before = await countTransactions(sql, accountId)
    const revisedBefore = await countRevised(sql, accountId)

    let fetched = 0
    let oldest: string | null = null
    let newest: string | null = null

    for await (const page of akahu.transactions(account._id, { start, end })) {
      fetched += page.length

      for (const txn of page) {
        // The same conversion writeTransactions makes. Taking the UTC day here
        // instead would report an oldest_transaction_date that no row in the
        // ledger actually has, and the Accounts page would name a day the
        // history does not start on.
        const date = nzDate(txn.date)
        if (oldest === null || date < oldest) oldest = date
        if (newest === null || date > newest) newest = date
      }

      await writeTransactions(sql, accountId, page)
    }

    const after = await countTransactions(sql, accountId)
    const revisedAfter = await countRevised(sql, accountId)

    const inserted = after - before
    const revised = revisedAfter - revisedBefore

    totalFetched += fetched
    totalNew += inserted
    totalRevised += revised

    // The number that matters: what we asked for versus what we got.
    const shortfallDays = oldest
      ? Math.round((Date.parse(oldest) - start.getTime()) / 86_400_000)
      : null

    await sql`
      update accounts set
        last_synced_at          = now(),
        backfill_completed_at   = now(),
        oldest_transaction_date = ${oldest},
        backfill_notes          = ${
          oldest
            ? `requested ${iso(start)}, oldest returned ${oldest} (${shortfallDays} days short of the request)`
            : `requested ${iso(start)}, no transactions returned`
        }
      where id = ${accountId}
    `

    const line: AccountReport = {
      event: 'backfill.account',
      account: `${account.connection?.name ?? '?'} / ${account.name}`,
      type: account.type ?? null,
      requested_from: iso(start),
      oldest_returned: oldest,
      newest_returned: newest,
      days_short_of_request: shortfallDays,
      fetched,
      inserted,
      revised,
    }
    report.push(line)
    log(line)
  }

  await sql`
    update sync_runs set
      status               = 'success',
      finished_at          = now(),
      accounts_synced      = ${accounts.length},
      transactions_fetched = ${totalFetched},
      transactions_new     = ${totalNew},
      transactions_revised = ${totalRevised},
      details              = ${sql.json({ requested_from: iso(start), requested_to: iso(end), accounts: report })}
    where id = ${runId}
  `

  log({
    event: 'backfill.complete',
    accounts: accounts.length,
    fetched: totalFetched,
    inserted: totalNew,
    revised: totalRevised,
    note: 'run `npm run recompute` to classify',
  })
} catch (error) {
  if (runId) {
    await sql`
      update sync_runs set status = 'failed', finished_at = now(), error = ${String(error)}
      where id = ${runId}
    `
  }
  log({ event: 'backfill.failed', error: String(error) })
  process.exitCode = 1
  throw error
} finally {
  await sql.end()
}

// ---------------------------------------------------------------------------

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(fields) + '\n')
}
