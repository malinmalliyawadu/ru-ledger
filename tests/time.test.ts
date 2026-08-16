/**
 * New Zealand time. No database.
 *
 * These tests exist because the failure they guard against is invisible. A date
 * taken in UTC is a real date, on a real day, only the wrong one - and only for
 * the twelve hours of every New Zealand day that fall on the previous UTC day.
 * Nothing throws, nothing looks broken, and a transaction quietly lands in the
 * month before the one it belongs to.
 *
 * The process timezone is deliberately not set here. If any of this depended on
 * where the machine thinks it is, these would pass on a laptop in Wellington
 * and fail in a UTC container, which is exactly the bug.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NZ_TIMEZONE, nzDate, nzHour, nzToday } from '../src/lib/time.ts'

test('an instant before the UTC day rolls over is still today here', () => {
  // 00:30 on 17 August in Wellington. UTC is still on the 16th.
  const instant = '2026-08-16T12:30:00.000Z'

  assert.equal(instant.slice(0, 10), '2026-08-16')
  assert.equal(nzDate(instant), '2026-08-17')
})

test('the last night of a month belongs to the month that is ending', () => {
  // 23:00 on 31 August here - the final hour of August, and already 1 September
  // in London. A month boundary is where this stops being cosmetic: the
  // transaction counts against a period that has closed.
  assert.equal(nzDate('2026-08-31T11:00:00.000Z'), '2026-08-31')
})

test('daylight saving is followed, not approximated', () => {
  // NZDT (UTC+13) from late September to early April, NZST (UTC+12) otherwise.
  // A fixed +12 offset would put the first of these on the previous day.
  assert.equal(nzDate('2026-01-14T11:30:00.000Z'), '2026-01-15') // +13
  assert.equal(nzDate('2026-07-14T11:30:00.000Z'), '2026-07-14') // +12
})

test('nzDate accepts a Date as readily as a string', () => {
  assert.equal(nzDate(new Date('2026-08-16T12:30:00.000Z')), '2026-08-17')
})

test('a date is emitted zero-padded, so it sorts and compares as a string', () => {
  // Half this app compares dates with < and >= on the string form.
  assert.equal(nzDate('2026-03-05T00:00:00.000Z'), '2026-03-05')
  assert.match(nzToday(), /^\d{4}-\d{2}-\d{2}$/)
})

test('midnight is hour zero, not hour twenty-four', () => {
  assert.equal(nzHour(new Date('2026-08-16T12:00:00.000Z')), 0) // 00:00 NZST
  assert.equal(nzHour(new Date('2026-08-16T23:00:00.000Z')), 11)
  assert.equal(nzHour(new Date('2026-08-16T06:00:00.000Z')), 18)
})

test('the timezone is a real IANA zone the runtime knows', () => {
  assert.equal(NZ_TIMEZONE, 'Pacific/Auckland')
  assert.doesNotThrow(() => new Intl.DateTimeFormat('en-NZ', { timeZone: NZ_TIMEZONE }))
})
