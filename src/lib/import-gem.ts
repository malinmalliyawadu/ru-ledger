/**
 * Importing a Latitude/Gem statement.
 *
 * Shared by the CLI and the upload form so there is one definition of the
 * natural key. If the two ever computed it differently, importing the same file
 * through the other route would duplicate a year of transactions.
 */

import { createHash } from 'node:crypto'
import type postgres from 'postgres'

import { parseGemStatement } from './csv.ts'

export const GEM_ACCOUNT = {
  externalId: 'gem-flight-centre',
  name: 'Flight Centre Mastercard',
  institution: 'Latitude',
  type: 'CREDITCARD',
  // A file someone has to remember to export gets a month before it is called
  // stale, where an Akahu account gets three days.
  staleAfterDays: 35,
}

export type ImportResult = {
  rowsInFile: number
  inserted: number
  alreadyPresent: number
  accountTotal: number
  from: string
  to: string
  debits: number
  credits: number
}

/** Parses and keys the rows without touching the database. */
export function prepareGemStatement(text: string, filename: string) {
  const rows = parseGemStatement(text)
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
      .update(`csv|${GEM_ACCOUNT.externalId}|${row.rawLine}|${occurrence}`)
      .digest('hex')
      .slice(0, 40)

    return { ...row, externalId, filename }
  })

  const dates = keyed.map((row) => row.date).sort()

  return { keyed, from: dates[0]!, to: dates.at(-1)! }
}

export async function importGemStatement(
  sql: postgres.Sql,
  input: { text: string; filename: string },
): Promise<ImportResult> {
  const { keyed, from, to } = prepareGemStatement(input.text, input.filename)

  return sql.begin(async (tx) => {
    const [account] = await tx<{ id: string }[]>`
      insert into accounts (external_id, source, name, institution, type,
                            stale_after_days, first_connected_at)
      values (${GEM_ACCOUNT.externalId}, 'csv', ${GEM_ACCOUNT.name}, ${GEM_ACCOUNT.institution},
              ${GEM_ACCOUNT.type}, ${GEM_ACCOUNT.staleAfterDays}, now())
      on conflict (source, external_id) do update set
        name             = excluded.name,
        institution      = excluded.institution,
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
        backfill_notes          = ${`manual CSV import; latest file ${input.filename}`}
      where id = ${accountId}
    `

    const inserted = Number(after!.n) - Number(before!.n)

    return {
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
