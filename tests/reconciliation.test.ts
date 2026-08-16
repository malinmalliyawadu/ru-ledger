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

  /**
   * The buckets must still partition the ledger once transactions have been
   * recategorised by hand.
   *
   * The assertion above cannot see this. It reads whatever is in the database,
   * and the database CI builds is seeded from the rules file with no overrides
   * in it — so both halves of a view that disagreed about overrides read the
   * same numbers and drift came out at zero. Prod, where the overrides live,
   * was out by five figures the whole time.
   *
   * So this writes the overrides itself, one of every shape the UI can produce,
   * and rolls them back. It is the only test here that does not trust the
   * ambient data to contain the interesting case.
   */
  test('the buckets still add up once transactions are overridden', async () => {
    const Rollback = Symbol('rollback')
    const drift = await sql
      .begin(async (tx) => {
        const [category] = await tx<{ id: string }[]>`
          select id from categories where kind = 'expense' and is_consumption limit 1
        `
        assert.ok(category, 'no consumption category to override into')

        // Each shape below reaches a different branch of the override lateral in
        // the transactions view. Cases 1, 3 and 4 used to be counted twice;
        // case 2 used to be dropped entirely.
        const shapes = [
          // rules excluded it, overridden into a category
          tx`insert into overrides (transaction_id, category_id)
             select r.id, ${category.id} from transactions_raw r
             join transactions_enriched e on e.transaction_id = r.id
             where e.exclusion_reason is not null limit 3`,
          // rules categorised it, overridden into an exclusion
          tx`insert into overrides (transaction_id, exclusion_reason)
             select r.id, 'internal_transfer' from transactions_raw r
             join transactions_enriched e on e.transaction_id = r.id
             where e.category_id is not null and e.exclusion_reason is null limit 3`,
          // rules could not place it, overridden into a category
          tx`insert into overrides (transaction_id, category_id)
             select r.id, ${category.id} from transactions_raw r
             join transactions_enriched e on e.transaction_id = r.id
             where e.classified_by = 'unmatched' limit 3`,
        ]

        let written = 0
        for (const shape of shapes) written += (await shape).count

        // Force-inclusion is inserted last and skips anything already
        // overridden, since overrides is keyed by transaction_id. It is the
        // shape with no category and no exclusion, which is why the partition
        // keys on the resolved values rather than on classified_by.
        written += (
          await tx`insert into overrides (transaction_id, force_included)
                   select r.id, true from transactions_raw r
                   join transactions_enriched e on e.transaction_id = r.id
                   where e.exclusion_reason is not null and e.category_id is null
                     and r.id not in (select transaction_id from overrides) limit 3`
        ).count

        assert.ok(written > 0, 'no transactions available to override; fixture proves nothing')

        const [row] = await tx<Record<string, string>[]>`select * from reconciliation`
        const out =
          round2(
            Number(row!.net_cash) -
              (Number(row!.income_signed) +
                Number(row!.spend_signed) +
                Number(row!.non_consumption_signed) +
                Number(row!.excluded_signed) +
                Number(row!.unclassified_signed)),
          ) + 0

        throw Object.assign(new Error('rollback'), { [Rollback]: true, drift: out, written })
      })
      .catch((error: { [k: symbol]: boolean; drift: number; written: number }) => {
        if (!error[Rollback]) throw error
        return error
      })

    assert.equal(
      drift.drift,
      0,
      `out by ${drift.drift} after ${drift.written} overrides: reconciliation is reading ` +
        `transactions_enriched somewhere it should be reading the override-resolved view`,
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
