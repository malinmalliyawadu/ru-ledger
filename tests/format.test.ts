/**
 * How dates and times are printed. No database.
 *
 * The thing worth guarding is that none of it depends on where the machine
 * thinks it is. These run under whatever TZ the runner was started with, which
 * is UTC in CI and New Zealand time on a laptop here - and the same assertions
 * have to hold in both. That is not pedantry: a page rendered on a UTC server
 * and hydrated in a New Zealand browser has to produce the same words twice, or
 * React reports a hydration mismatch and the reader watches a date change on
 * its own a moment after the page loads.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dateTime, fullDate, instantDate, isoDate, monthLabel, shortDate } from '../src/lib/format.ts'

test('a calendar date prints as the day it is, wherever this runs', () => {
  assert.equal(fullDate('2026-08-01'), '1 Aug 2026')
  assert.equal(shortDate('2026-08-01'), '1 Aug')
  assert.equal(isoDate('2026-08-01'), '2026-08-01')
})

test('the first of the month does not slip into the month before', () => {
  // The failure this pins: formatted in a zone behind UTC, the UTC-midnight peg
  // lands on 31 July and every heading in the app names the wrong month.
  assert.equal(monthLabel('2026-08-01'), 'August 2026')
  assert.equal(fullDate('2026-01-01'), '1 Jan 2026')
})

test('an instant is printed in New Zealand time', () => {
  // 00:30 on 17 August in Wellington, half an hour into a day UTC has not
  // reached yet.
  assert.equal(instantDate('2026-08-16T12:30:00.000Z'), '17 Aug 2026')

  const printed = dateTime('2026-08-16T12:30:00.000Z')
  assert.match(printed, /17 Aug 2026/)
  assert.match(printed, /12:30/)
})

test('daylight saving moves the printed clock, not just the date', () => {
  // The same UTC instant in January (NZDT, +13) and July (NZST, +12).
  assert.match(dateTime('2026-01-14T22:00:00.000Z'), /11:00/)
  assert.match(dateTime('2026-07-14T22:00:00.000Z'), /10:00/)
})
