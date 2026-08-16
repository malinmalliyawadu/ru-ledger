/**
 * Importing a statement CSV.
 *
 * Shared by the CLI and the upload form so there is exactly one definition of
 * the natural key. If the two ever computed it differently, importing the same
 * file through the other route would duplicate a year of transactions.
 */

import { createHash } from 'node:crypto'
import type postgres from 'postgres'

import { parseStatement } from './csv.ts'

/**
 * A file someone has to remember to export gets a month before it is called
 * stale, where an Akahu account gets three days.
 */
const STALE_AFTER_DAYS = 35

export type ImportResult = {
  account: string
  rowsInFile: number
  inserted: number
  alreadyPresent: number
  accountTotal: number
  from: string
  to: string
  debits: number
  credits: number
}

/**
 * The account a statement lands in is named by whoever uploads it, rather than
 * being guessed from the file.
 *
 * A CSV export carries no reliable account identity — some have a card number,
 * most have nothing — so guessing would eventually merge two cards into one
 * account, and there is no safe way back from that once the rows are keyed.
 * Asking is one field, and it makes importing a second card free.
 */
export function accountIdFor(accountName: string): string {
  const slug = accountName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (slug === '') throw new Error('Give the account a name.')
  return `csv-${slug}`
}

/** Parses and keys the rows without touching the database. */
export function prepareStatement(text: string, filename: string, accountName: string) {
  const externalAccountId = accountIdFor(accountName)
  const rows = parseStatement(text)
  if (rows.length === 0) throw new Error('That file has no transactions in it.')

  // Identical lines can legitimately appear twice in one statement — two $3.69
  // coffees on the same day at the same shop. Index them so each gets a
  // distinct key, and so the same file always produces the same keys.
  const seen = new Map<string, number>()

  const keyed = rows.map((row) => {
    const occurrence = seen.get(row.rawLine) ?? 0
    seen.set(row.rawLine, occurrence + 1)

    // Hashes the untouched line rather than the parsed fields, so changing how
    // descriptions are normalised later cannot silently duplicate history.
    const externalId = createHash('sha256')
      .update(`csv|${externalAccountId}|${row.rawLine}|${occurrence}`)
      .digest('hex')
      .slice(0, 40)

    return { ...row, externalId, filename }
  })

  const dates = keyed.map((row) => row.date).sort()

  return { keyed, externalAccountId, from: dates[0]!, to: dates.at(-1)! }
}

export async function importStatementFile(
  sql: postgres.Sql,
  input: { text: string; filename: string; accountName: string },
): Promise<ImportResult> {
  const name = input.accountName.trim()
  const { keyed, externalAccountId, from, to } = prepareStatement(input.text, input.filename, name)

  return sql.begin(async (tx) => {
    const [account] = await tx<{ id: string }[]>`
      insert into accounts (external_id, source, name, type,
                            stale_after_days, first_connected_at)
      values (${externalAccountId}, 'csv', ${name}, 'CREDITCARD',
              ${STALE_AFTER_DAYS}, now())
      on conflict (source, external_id) do update set
        name             = excluded.name,
        stale_after_days = excluded.stale_after_days
      returning id
    `

    const accountId = account!.id

    const [before] = await tx<{ n: string }[]>`
      select count(*) as n from transactions_raw where account_id = ${accountId}
    `

    const payload = keyed.map((row) => ({
      external_id: row.externalId,
      source: 'csv',
      account_id: accountId,
      date: row.date,
      description: row.description,
      amount: row.amount,
      raw: {
        source: 'csv',
        file: row.filename,
        line: row.lineNumber,
        raw_line: row.rawLine,
        card_number: row.cardNumber,
        date: row.date,
        description: row.description,
        amount: row.amount,
      },
    }))

    // do nothing, not do update: transactions_raw is immutable, and a statement
    // re-export is not an upstream correction.
    for (let i = 0; i < payload.length; i += 500) {
      await tx`
        insert into transactions_raw ${tx(payload.slice(i, i + 500))}
        on conflict (source, external_id) do nothing
      `
    }

    const [after] = await tx<{ n: string }[]>`
      select count(*) as n from transactions_raw where account_id = ${accountId}
    `

    await tx`
      update accounts set
        last_synced_at          = now(),
        oldest_transaction_date = least(coalesce(oldest_transaction_date, ${from}::date), ${from}::date),
        backfill_completed_at   = coalesce(backfill_completed_at, now()),
        backfill_notes          = ${`imported by hand; latest file ${input.filename}`}
      where id = ${accountId}
    `

    const inserted = Number(after!.n) - Number(before!.n)

    return {
      account: name,
      rowsInFile: keyed.length,
      inserted,
      alreadyPresent: keyed.length - inserted,
      accountTotal: Number(after!.n),
      from,
      to,
      debits: keyed.filter((r) => r.amount < 0).length,
      credits: keyed.filter((r) => r.amount > 0).length,
    }
  })
}
