/**
 * What gets written to transactions_raw. No database - the connection is a stub
 * that records the rows it was handed.
 *
 * Only the date is pinned here, because the date is the one field the ingest
 * derives rather than copies. Akahu sends an instant; the ledger stores the day
 * it was here when that instant happened, and getting that wrong is not a
 * display bug - it files the transaction under the wrong month, where it is
 * counted against a period that has already been read and reconciled.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type postgres from 'postgres'

import type { AkahuTransaction } from '../src/lib/akahu.ts'
import { writeTransactions } from '../src/lib/ingest.ts'

type Row = { external_id: string; date: string }

/**
 * Stands in for postgres.js closely enough for this one path: it is called
 * both as a tagged template and as `sql(rows)` to build the insert list.
 */
function stubSql(): { sql: postgres.Sql; rows: () => Row[] } {
  let captured: Row[] = []

  const sql = ((first: unknown, ...rest: unknown[]) => {
    // A tagged template: first argument is the strings array.
    if (Array.isArray(first) && Object.hasOwn(first, 'raw')) {
      // The insert interpolates the row list; the follow-up statement
      // interpolates a list of ids, which is not what this is watching for.
      for (const value of rest) {
        if (Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null)) {
          captured = value as Row[]
        }
      }
      return Promise.resolve([])
    }
    // sql(rows) - postgres.js returns a fragment; the identity is enough here.
    return first
  }) as unknown as postgres.Sql

  return { sql, rows: () => captured }
}

const transaction = (id: string, date: string): AkahuTransaction => ({
  _id: id,
  _account: 'acc_1',
  date,
  description: 'COUNTDOWN NEWTOWN',
  amount: -42.5,
})

test('a transaction after midnight here is filed under today, not yesterday UTC', async () => {
  const { sql, rows } = stubSql()

  // 00:30 on 17 August in Wellington.
  await writeTransactions(sql, 'acc_1', [transaction('t_1', '2026-08-16T12:30:00.000Z')])

  assert.equal(rows()[0]!.date, '2026-08-17')
})

test('a late-night spend on the last of the month stays in that month', async () => {
  const { sql, rows } = stubSql()

  // 23:00 on 31 August here, which is already September in UTC.
  await writeTransactions(sql, 'acc_1', [transaction('t_2', '2026-08-31T11:00:00.000Z')])

  assert.equal(rows()[0]!.date, '2026-08-31')
})

test('a plain daytime transaction is unchanged', async () => {
  const { sql, rows } = stubSql()

  await writeTransactions(sql, 'acc_1', [transaction('t_3', '2026-08-17T02:15:00.000Z')])

  assert.equal(rows()[0]!.date, '2026-08-17')
})

test('an empty page writes nothing at all', async () => {
  const { sql, rows } = stubSql()

  await writeTransactions(sql, 'acc_1', [])

  assert.deepEqual(rows(), [])
})
