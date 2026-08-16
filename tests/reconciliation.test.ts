/**
 * The reconciliation test. Requires a database, and is meant to fail CI.
 *
 * Two claims:
 *   1. Every raw transaction is classified exactly once.
 *   2. The classified buckets add back up to raw net cash.
 *
 * If either breaks, some money is being counted twice or dropped, and every
 * figure in the app is wrong by an amount nobody can see.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { connect } from '../src/lib/db.ts'

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required. These tests assert against real data and must not be skipped in CI.',
  )
}

const sql = connect()

describe('reconciliation', () => {
  let recon: Record<string, string>

  before(async () => {
    const [row] = await sql<Record<string, string>[]>`select * from reconciliation`
    recon = row ?? {}
  })

  after(async () => {
    await sql.end()
  })

  test('every raw transaction has a derived row', async () => {
    assert.equal(
      Number(recon.unenriched_count),
      0,
      'transactions_raw rows with no transactions_enriched row: run `npm run recompute`',
    )
  })

  test('no transaction is classified twice', async () => {
    // The check constraint makes category-and-exclusion impossible, so the only
    // remaining way to be classified twice is a duplicate derived row. The
    // primary key makes that impossible too; this asserts both still hold.
    const [dupes] = await sql<{ n: string }[]>`
      select count(*) as n from (
        select transaction_id from transactions_enriched group by 1 having count(*) > 1
      ) d
    `
    assert.equal(Number(dupes?.n), 0)

    const [both] = await sql<{ n: string }[]>`
      select count(*) as n from transactions_enriched
      where category_id is not null and exclusion_reason is not null
    `
    assert.equal(Number(both?.n), 0, 'a row may carry a category or an exclusion, never both')
  })

  test('the buckets add up to raw net cash', () => {
    const netCash = Number(recon.net_cash)
    const buckets =
      Number(recon.income_signed) +
      Number(recon.spend_signed) +
      Number(recon.non_consumption_signed) +
      Number(recon.excluded_signed) +
      Number(recon.unclassified_signed)

    // Everything is numeric(14,2), so this is exact arithmetic, not floating
    // point. A cent of tolerance would hide a real bug.
    //
    // Compared with `+ 0` rather than against 0 directly: Math.round of a tiny
    // negative difference returns -0, and assert.equal uses Object.is, under
    // which -0 !== 0. Adding zero normalises it. Without this the test fails on
    // a ledger that reconciles perfectly, which is the worst possible failure
    // mode for the one assertion whose job is to be trusted.
    const drift = round2(netCash - buckets) + 0

    assert.equal(drift, 0, `out by ${drift}: net cash ${netCash} vs buckets ${round2(buckets)}`)
  })

  test('card payments net out against the purchases they settle', async () => {
    // Not an identity — a statement can straddle a period boundary — but a
    // large one-sided total means only one leg is being excluded.
    const [row] = await sql<{ legs: string; net: string }[]>`
      select count(*) as legs, coalesce(sum(amount), 0) as net
      from transactions where exclusion_reason = 'card_payment'
    `
    const legs = Number(row?.legs ?? 0)
    if (legs === 0) return

    const gross = await sql<{ gross: string }[]>`
      select coalesce(sum(abs(amount)), 0) as gross
      from transactions where exclusion_reason = 'card_payment'
    `
    const ratio = Math.abs(Number(row?.net)) / Number(gross[0]?.gross ?? 1)
    assert.ok(
      ratio < 0.2,
      `card payment legs are ${(ratio * 100).toFixed(1)}% one-sided; one side is probably not being excluded`,
    )
  })

  test('categorisation coverage stays above 99%', async () => {
    const total = Number(recon.raw_count)
    if (total === 0) return

    const coverage = 1 - Number(recon.unmatched_count) / total
    assert.ok(
      coverage > 0.99,
      `coverage is ${(coverage * 100).toFixed(2)}% over ${total} transactions ` +
        `(${recon.unmatched_count} unmatched); add rules to data/categorisation-rules.json`,
    )
  })
})

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
