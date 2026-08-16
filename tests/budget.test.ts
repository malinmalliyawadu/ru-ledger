/**
 * Budgets: the versioning rule, and the verdict drawn from it.
 *
 * The database half asserts the one thing the whole design rests on — that the
 * line in force for a period is the newest one at or before it, and that
 * switching a category off does not rewrite what an earlier period was judged
 * against. Every assertion runs inside a transaction that is rolled back, so
 * these tests can be pointed at the real database without leaving a row behind.
 */

import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'
import type postgres from 'postgres'

import { connect } from '../src/lib/db.ts'
import { suggestedAmount, usedShare, verdictFor } from '../src/lib/budget.ts'

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required. These tests assert against real data and must not be skipped in CI.',
  )
}

const sql = connect()

/** Thrown to unwind a transaction that was only ever meant to be a scratchpad. */
class Rollback extends Error {}

async function scratch(run: (tx: postgres.TransactionSql<{}>) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await run(tx)
      throw new Rollback()
    })
  } catch (error) {
    if (!(error instanceof Rollback)) throw error
  }
}

async function budgetAt(
  tx: postgres.TransactionSql<{}>,
  categoryId: string,
  periodStart: string,
): Promise<number | null | undefined> {
  const rows = await tx<{ amount: string | null }[]>`
    select amount from budget_for_period(${periodStart}) where category_id = ${categoryId}
  `
  if (rows.length === 0) return undefined
  return rows[0]!.amount === null ? null : Number(rows[0]!.amount)
}

async function scratchCategory(tx: postgres.TransactionSql<{}>): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into categories (name, slug, kind)
    values ('Budget test scratch', 'budget-test-scratch', 'expense')
    returning id
  `
  return row!.id
}

describe('budget_for_period', () => {
  after(async () => {
    await sql.end()
  })

  test('the newest line at or before the period is the one in force', async () => {
    await scratch(async (tx) => {
      const category = await scratchCategory(tx)
      await tx`
        insert into budget_lines (category_id, effective_from, amount)
        values (${category}, '2026-01-16', 400), (${category}, '2026-04-16', 550)
      `

      // Nothing was set yet, which is not the same as a budget of zero.
      assert.equal(await budgetAt(tx, category, '2025-12-16'), undefined)

      assert.equal(await budgetAt(tx, category, '2026-01-16'), 400)
      assert.equal(await budgetAt(tx, category, '2026-03-16'), 400, 'carries forward until superseded')
      assert.equal(await budgetAt(tx, category, '2026-04-16'), 550)
      assert.equal(await budgetAt(tx, category, '2027-01-16'), 550, 'and keeps carrying forward')
    })
  })

  test('switching a category off leaves earlier periods judged as they were', async () => {
    await scratch(async (tx) => {
      const category = await scratchCategory(tx)
      await tx`
        insert into budget_lines (category_id, effective_from, amount)
        values (${category}, '2026-01-16', 400), (${category}, '2026-04-16', null)
      `

      assert.equal(await budgetAt(tx, category, '2026-02-16'), 400)
      // The tombstone is returned rather than hidden: the editor has to be able
      // to tell "switched off" from "never set".
      assert.equal(await budgetAt(tx, category, '2026-04-16'), null)
      assert.equal(await budgetAt(tx, category, '2026-09-16'), null)
    })
  })

  test('a category can carry only one line per period', async () => {
    await scratch(async (tx) => {
      const category = await scratchCategory(tx)
      await tx`
        insert into budget_lines (category_id, effective_from, amount)
        values (${category}, '2026-01-16', 400)
      `
      await assert.rejects(
        tx`
          insert into budget_lines (category_id, effective_from, amount)
          values (${category}, '2026-01-16', 500)
        `,
        /budget_lines_category_id_effective_from_key/,
      )
    })
  })

  test('a negative budget is rejected', async () => {
    await scratch(async (tx) => {
      const category = await scratchCategory(tx)
      await assert.rejects(
        tx`
          insert into budget_lines (category_id, effective_from, amount)
          values (${category}, '2026-01-16', -1)
        `,
        /budget_lines_amount_non_negative/,
      )
    })
  })
})

describe('reading a budget line', () => {
  test('over the limit is over, whether or not the period has finished', () => {
    const line = { budget: 400, spent: 460, expectedByNow: 200 }
    assert.equal(verdictFor(line, true).tone, 'over')
    assert.equal(verdictFor(line, false).tone, 'over')
  })

  test('pace is judged against the period, not against the whole limit', () => {
    // Half the budget gone at the quarter point is fine by the limit and not
    // fine by the pace. Saying so is the only reason this page beats a table.
    const early = verdictFor({ budget: 400, spent: 200, expectedByNow: 100 }, true)
    assert.equal(early.tone, 'ahead')

    const onPace = verdictFor({ budget: 400, spent: 100, expectedByNow: 100 }, true)
    assert.equal(onPace.tone, 'on-track')
  })

  test('a closed period under its limit reports what was left', () => {
    const verdict = verdictFor({ budget: 400, spent: 250, expectedByNow: 400 }, false)
    assert.equal(verdict.tone, 'under')
    assert.match(verdict.label, /150/)
  })

  test('a category with nothing spent in a closed period is not a triumph', () => {
    assert.equal(verdictFor({ budget: 400, spent: 0, expectedByNow: 400 }, false).tone, 'unused')
  })

  test('a budget of zero is a real answer, not a division by zero', () => {
    assert.equal(usedShare(0, 0), 0)
    assert.equal(usedShare(25, 0), 1)
    assert.equal(verdictFor({ budget: 0, spent: 25, expectedByNow: 0 }, true).tone, 'over')
  })

  test('a bar cannot overflow its track', () => {
    assert.equal(usedShare(900, 400), 1)
    assert.equal(usedShare(-40, 400), 0, 'a refunded category is empty, not negative')
  })

  test('suggestions are round figures, and small ones are not suggested at all', () => {
    assert.equal(suggestedAmount(487.31), 490)
    assert.equal(suggestedAmount(4.5), null)
  })
})
