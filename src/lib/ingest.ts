/**
 * Writing Akahu data into transactions_raw.
 *
 * Shared by the one-off backfill and the daily sync so the two cannot drift
 * apart on the thing that matters most: the upsert being idempotent, and an
 * existing row only ever being touched when the upstream payload genuinely
 * changed.
 */

import type postgres from 'postgres'

import type { AkahuAccount, AkahuTransaction } from './akahu.ts'

export async function upsertAccount(sql: postgres.Sql, account: AkahuAccount): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into accounts (external_id, source, name, institution, type, currency,
                          current_balance, balance_as_at, first_connected_at)
    values (${account._id}, 'akahu', ${account.name}, ${account.connection?.name ?? null},
            ${account.type ?? null}, ${account.balance?.currency ?? 'NZD'},
            ${account.balance?.current ?? null},
            ${account.refreshed?.balance ?? null}, now())
    on conflict (source, external_id) do update set
      name            = excluded.name,
      institution     = excluded.institution,
      type            = excluded.type,
      currency        = excluded.currency,
      current_balance = excluded.current_balance,
      balance_as_at   = excluded.balance_as_at
    returning id
  `
  return row!.id
}

/**
 * Writes one page of transactions.
 *
 * The `where` clause on the upsert is the important part. Without it every sync
 * would rewrite every overlapping row, stamping revised_at on transactions that
 * never changed and making genuine upstream corrections impossible to find.
 */
export async function writeTransactions(
  sql: postgres.Sql,
  accountId: string,
  page: AkahuTransaction[],
): Promise<void> {
  if (page.length === 0) return

  const rows = page.map((txn) => ({
    external_id: txn._id,
    source: 'akahu',
    account_id: accountId,
    date: txn.date.slice(0, 10),
    description: txn.description,
    amount: txn.amount,
    raw: txn,
  }))

  await sql`
    insert into transactions_raw ${sql(rows)}
    on conflict (source, external_id) do update set
      date        = excluded.date,
      description = excluded.description,
      amount      = excluded.amount,
      raw         = excluded.raw,
      revised_at  = now()
    where transactions_raw.raw is distinct from excluded.raw
  `

  await sql`
    update transactions_raw set last_seen_at = now()
    where source = 'akahu' and external_id = any(${page.map((t) => t._id)})
  `
}

export async function countTransactions(sql: postgres.Sql, accountId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*) as n from transactions_raw where account_id = ${accountId}
  `
  return Number(row!.n)
}

export async function countRevised(sql: postgres.Sql, accountId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*) as n from transactions_raw
    where account_id = ${accountId} and revised_at is not null
  `
  return Number(row!.n)
}
