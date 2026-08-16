/**
 * Cadence detection. The interesting cases are the negatives: a merchant
 * visited often is not a subscription, and calling one a subscription puts a
 * false "possibly cancelled" warning in front of you every time you skip lunch.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSeries, classifyCadence, detectRecurring } from '../src/lib/recurring.ts'

const day = 86_400_000
const from = (start: string, gaps: number[]) => {
  const dates = [new Date(`${start}T00:00:00Z`)]
  for (const gap of gaps) dates.push(new Date(dates.at(-1)!.getTime() + gap * day))
  return dates.map((date) => ({ date, amount: -20 }))
}

const asOf = new Date('2026-08-15T00:00:00Z')

test('cadence bands', () => {
  assert.equal(classifyCadence(7), 'weekly')
  assert.equal(classifyCadence(14), 'fortnightly')
  assert.equal(classifyCadence(30), 'monthly')
  assert.equal(classifyCadence(31), 'monthly')
  assert.equal(classifyCadence(91), 'quarterly')
  assert.equal(classifyCadence(365), 'annual')
  assert.equal(classifyCadence(3), 'irregular')
})

test('a monthly direct debit is detected', () => {
  const series = buildSeries('Netflix', from('2026-01-05', [31, 28, 31, 30, 31, 30]), asOf)
  assert.ok(series)
  assert.equal(series.cadence, 'monthly')
  assert.equal(series.chargeCount, 7)
})

test('two charges are not a rhythm', () => {
  assert.equal(buildSeries('Anything', from('2026-06-01', [30]), asOf), null)
})

test('a frequently visited merchant is not a subscription', () => {
  // A lunch place: often enough that the median gap looks fortnightly, while
  // almost no individual gap is.
  const lunch = from('2025-09-02', [3, 21, 6, 34, 9, 2, 27, 14, 5, 41, 8])
  assert.equal(buildSeries('Pita Pit', lunch, asOf), null)
})

test('the supermarket every few days is not a subscription', () => {
  const groceries = from('2026-05-01', [3, 4, 3, 4, 3, 4, 3, 4])
  assert.equal(buildSeries('New World', groceries, asOf), null, 'a 3.5 day rhythm is not a billing cycle')
})

test('a cancelled subscription is flagged once it is overdue by twice its interval', () => {
  // Monthly, last charged 19 March, checked in August.
  const stopped = buildSeries('Neon', from('2025-10-19', [31, 30, 31, 31, 28]), asOf)
  assert.ok(stopped)
  assert.equal(stopped.cadence, 'monthly')
  assert.ok(stopped.daysSinceLast > stopped.medianGapDays * 2)
  assert.equal(stopped.possiblyCancelled, true)
})

test('a subscription charged on time is not flagged', () => {
  const healthy = buildSeries('Vercel', from('2026-03-10', [31, 30, 31, 30, 31]), asOf)
  assert.ok(healthy)
  assert.equal(healthy.possiblyCancelled, false)
})

test('monthly equivalent normalises across cadences', () => {
  const weekly = buildSeries('Weekly thing', from('2026-06-01', [7, 7, 7, 7, 7]), asOf)
  assert.ok(weekly)
  // $20 a week is about $86.67 a month.
  assert.ok(Math.abs(weekly.monthlyEquivalent - (20 * 52) / 12) < 0.01)
})

test('detectRecurring groups by merchant and drops the noise', () => {
  const rows = [
    ...from('2026-01-05', [31, 28, 31, 30]).map((c) => ({ ...c, merchant: 'Netflix' })),
    ...from('2026-02-02', [3, 19, 4, 28, 7]).map((c) => ({ ...c, merchant: 'Random Cafe' })),
  ]
  const series = detectRecurring(rows, asOf)
  assert.deepEqual(
    series.map((s) => s.merchant),
    ['Netflix'],
  )
})
