import { NZ_TIMEZONE, nzDate } from './time.ts'

const NZD = new Intl.NumberFormat('en-NZ', {
  style: 'currency',
  currency: 'NZD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const NZD_WHOLE = new Intl.NumberFormat('en-NZ', {
  style: 'currency',
  currency: 'NZD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
})

/** Exact figure, for tables and anything that has to reconcile. */
export function money(value: number | string): string {
  return NZD.format(Number(value))
}

/** Rounded figure, for headlines where cents are noise. */
export function moneyWhole(value: number | string): string {
  return NZD_WHOLE.format(Number(value))
}

export function percent(value: number, digits = 0): string {
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`
}

/**
 * Calendar dates below, instants at the bottom of the file, and the two are
 * kept apart on purpose.
 *
 * A transaction date is a day with no time and no zone, carried as `YYYY-MM-DD`
 * and pegged at UTC midnight when it has to be a Date. These formatters are
 * therefore fixed to UTC - not as a timezone, but so the peg is read back at
 * the same place it was set. Formatting one in a local zone is how a date
 * silently becomes the day before on a machine behind UTC.
 *
 * A `timestamptz` is the other thing entirely: a real instant, which has to be
 * told which day it was in New Zealand before it can be printed. That is what
 * dateTime and instantDate are for.
 */
const DAY_MONTH = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const MONTH_SHORT = new Intl.DateTimeFormat('en-NZ', { month: 'short', timeZone: 'UTC' })

export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(`${value}T00:00:00Z`)
}

export function shortDate(value: Date | string): string {
  return DAY_MONTH.format(toDate(value))
}

export function fullDate(value: Date | string): string {
  return DAY_MONTH_YEAR.format(toDate(value))
}

const MONTH_YEAR = new Intl.DateTimeFormat('en-NZ', { month: 'long', year: 'numeric', timeZone: 'UTC' })

/**
 * "August 2026" for an ordinary month, which is what every period is here.
 *
 * A period only stops being a calendar month if the start day is moved off the
 * 1st — a supported but unusual choice, for someone who would rather the month
 * ran payday to payday. In that case the label falls back to spelling the dates
 * out, because calling 20 Aug – 19 Sep "August" would be a small lie told on
 * every screen in the app.
 */
export function monthLabel(start: Date | string, end?: Date | string): string {
  const from = toDate(start)
  if (from.getUTCDate() === 1) return MONTH_YEAR.format(from)
  if (end === undefined) return DAY_MONTH_YEAR.format(from)
  return `${DAY_MONTH.format(from)} – ${DAY_MONTH_YEAR.format(toDate(end))}`
}

/** Compact label for chart axes. */
export function monthTick(start: Date | string): string {
  const date = toDate(start)
  const month = MONTH_SHORT.format(date)
  return date.getUTCMonth() === 0 ? `${month} ${String(date.getUTCFullYear()).slice(2)}` : month
}

export function isoDate(value: Date | string): string {
  return toDate(value).toISOString().slice(0, 10)
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

const NZ_DATE_TIME = new Intl.DateTimeFormat('en-NZ', {
  timeZone: NZ_TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

/**
 * A moment in time - when a sync ran, when a passkey was used - in New Zealand
 * time, whatever the machine rendering it thinks the zone is.
 *
 * Naming the zone rather than leaving it to the runtime is what keeps the
 * server and the browser agreeing. A component rendered on a UTC server and
 * hydrated in a New Zealand browser otherwise produces two different strings
 * for the same timestamp, which React reports as a hydration mismatch and the
 * reader sees as a time that changes on its own a moment after the page loads.
 */
export function dateTime(value: Date | string): string {
  return NZ_DATE_TIME.format(value instanceof Date ? value : new Date(value))
}

/** The day an instant fell on, here. For timestamps shown as dates alone. */
export function instantDate(value: Date | string): string {
  return fullDate(nzDate(value))
}
