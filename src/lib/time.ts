/**
 * New Zealand time, in one place.
 *
 * This is a ledger for one person living in one country, and every question it
 * answers is asked in local time: "what did I spend today", "is rent paid this
 * month", "how much is left before payday". None of those mean anything in UTC.
 *
 * The trap is that almost nothing else here runs in New Zealand. The server may
 * be anywhere, containers default to UTC, and Postgres has its own idea of what
 * day it is. New Zealand is UTC+12/+13, so for the first half of every local day
 * a UTC clock is still on yesterday - which is not a rounding error when it
 * decides which month a transaction belongs to, or whether rent is still to
 * come. So the zone is never inferred from the environment. It is named here,
 * and everything that needs a date or a clock goes through this file.
 *
 * Calendar dates are the other half of the story. A transaction date is a day,
 * not an instant: it has no time and no zone. Those are carried as `YYYY-MM-DD`
 * strings, and where a Date object is needed they are anchored at UTC midnight -
 * see `toDate` in format.ts. UTC there is not a timezone choice, it is just a
 * neutral peg, and such values must be read back with UTC accessors so the day
 * survives the round trip. Instants - `timestamptz` columns, `new Date()` - are
 * the opposite: real points in time that only become a date once this file says
 * which day they landed on here.
 */

export const NZ_TIMEZONE = 'Pacific/Auckland'

const NZ_DATE_PARTS = new Intl.DateTimeFormat('en-NZ', {
  timeZone: NZ_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * The New Zealand calendar date an instant fell on, as `YYYY-MM-DD`.
 *
 * Accepts anything `new Date()` does, which in practice means the ISO
 * timestamps Akahu returns.
 */
export function nzDate(instant: Date | string | number = new Date()): string {
  const date = instant instanceof Date ? instant : new Date(instant)
  const parts = NZ_DATE_PARTS.formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''

  return `${part('year')}-${part('month')}-${part('day')}`
}

/** Today, here, as `YYYY-MM-DD`. The app's answer to "what day is it". */
export function nzToday(now: Date = new Date()): string {
  return nzDate(now)
}

const NZ_HOUR = new Intl.DateTimeFormat('en-NZ', {
  timeZone: NZ_TIMEZONE,
  hour: 'numeric',
  hour12: false,
})

/** Hour of the local day, 0–23. */
export function nzHour(now: Date = new Date()): number {
  // en-NZ renders midnight as "24" rather than "0".
  return Number(NZ_HOUR.format(now)) % 24
}
