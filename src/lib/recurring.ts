/**
 * Cadence detection.
 *
 * Subscriptions are not labelled in bank data, so the only signal is rhythm:
 * the same merchant charging at a consistent interval. This works out that
 * interval from the gaps between charges and flags anything now overdue by more
 * than twice its own rhythm, which is how a forgotten subscription that quietly
 * stopped, or one that quietly did not, becomes visible.
 *
 * `asOf` is a parameter rather than a call to the clock so the result is
 * reproducible and testable.
 */

export type Cadence =
  | 'weekly'
  | 'fortnightly'
  | 'monthly'
  | 'quarterly'
  | 'annual'
  | 'irregular'

export type Charge = { date: Date; amount: number }

export type RecurringSeries = {
  merchant: string
  charges: Charge[]
  chargeCount: number
  medianGapDays: number
  cadence: Cadence
  lastCharged: Date
  daysSinceLast: number
  /** Overdue by more than twice its own interval. */
  possiblyCancelled: boolean
  averageAmount: number
  totalAmount: number
  monthlyEquivalent: number
}

/** A rhythm needs at least three charges before two gaps can agree on one. */
export const MIN_CHARGES = 3

const CADENCE_BANDS: { cadence: Cadence; min: number; max: number; perYear: number }[] = [
  { cadence: 'weekly', min: 5, max: 9, perYear: 52 },
  { cadence: 'fortnightly', min: 11, max: 17, perYear: 26 },
  { cadence: 'monthly', min: 26, max: 35, perYear: 12 },
  { cadence: 'quarterly', min: 80, max: 100, perYear: 4 },
  { cadence: 'annual', min: 350, max: 380, perYear: 1 },
]

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export function classifyCadence(medianGapDays: number): Cadence {
  return (
    CADENCE_BANDS.find((band) => medianGapDays >= band.min && medianGapDays <= band.max)?.cadence ??
    'irregular'
  )
}

const DAY_MS = 86_400_000

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS)
}

/**
 * Builds a series from one merchant's charges. Returns null when there are too
 * few charges to claim a rhythm, or when the gaps are too erratic to be one.
 */
export function buildSeries(
  merchant: string,
  charges: Charge[],
  asOf: Date,
): RecurringSeries | null {
  if (charges.length < MIN_CHARGES) return null

  const sorted = [...charges].sort((a, b) => a.date.getTime() - b.date.getTime())
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push(daysBetween(sorted[i - 1]!.date, sorted[i]!.date))
  }

  const medianGapDays = median(gaps)
  if (medianGapDays <= 0) return null

  // A rhythm has to be a recognisable billing rhythm. Anything that does not
  // land in a known band is a merchant visited often, not something charging on
  // a cycle — the supermarket every three or four days is the clearest case.
  const cadence = classifyCadence(medianGapDays)
  if (cadence === 'irregular') return null

  // And the gaps have to actually agree. A lunch place visited most weeks has a
  // median gap that looks fortnightly while no individual gap is fortnightly;
  // holding the tolerance to a third of the interval separates a direct debit
  // from a habit.
  const consistent = gaps.filter(
    (gap) => Math.abs(gap - medianGapDays) <= Math.max(2, medianGapDays * 0.35),
  ).length
  if (consistent / gaps.length < 0.7) return null

  const lastCharged = sorted.at(-1)!.date
  const daysSinceLast = Math.max(0, daysBetween(lastCharged, asOf))
  const total = sorted.reduce((sum, c) => sum + Math.abs(c.amount), 0)
  const perYear = CADENCE_BANDS.find((b) => b.cadence === cadence)?.perYear ?? 365 / medianGapDays

  return {
    merchant,
    charges: sorted,
    chargeCount: sorted.length,
    medianGapDays,
    cadence,
    lastCharged,
    daysSinceLast,
    possiblyCancelled: daysSinceLast > medianGapDays * 2,
    averageAmount: total / sorted.length,
    totalAmount: total,
    monthlyEquivalent: ((total / sorted.length) * perYear) / 12,
  }
}

/** Groups charges by merchant and returns every series that reads as recurring. */
export function detectRecurring(
  rows: { merchant: string; date: Date; amount: number }[],
  asOf: Date,
): RecurringSeries[] {
  const groups = new Map<string, Charge[]>()

  for (const row of rows) {
    const charges = groups.get(row.merchant)
    if (charges) charges.push({ date: row.date, amount: row.amount })
    else groups.set(row.merchant, [{ date: row.date, amount: row.amount }])
  }

  return [...groups.entries()]
    .map(([merchant, charges]) => buildSeries(merchant, charges, asOf))
    .filter((series): series is RecurringSeries => series !== null)
    .sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent)
}
