import { moneyWhole } from './format.ts'

/**
 * Reading a budget line: is this figure fine, or is it not?
 *
 * Pure, and deliberately separate from the query that produces the numbers, so
 * the headline and every category row reach the same verdict from the same
 * rule. A page that says "on track" at the top while every row underneath is
 * amber is worse than no verdict at all.
 */

export type BudgetTone = 'over' | 'ahead' | 'on-track' | 'under' | 'unused'

export type BudgetVerdict = {
  tone: BudgetTone
  label: string
  /** Maps onto the tag classes in globals.css. */
  tag: 'tag-alert' | 'tag-warn' | 'tag-living' | 'tag-ghost'
}

export type BudgetProgress = {
  budget: number
  spent: number
  /** What the budget allows by this point in the period. Ignored once closed. */
  expectedByNow: number
}

/**
 * A few percent past the expected point is measurement noise, not a signal:
 * a single weekly shop landing a day early moves a small category by more than
 * this. Flagging it would make amber the resting state and mean nothing.
 */
const PACE_TOLERANCE = 1.05

export function verdictFor(progress: BudgetProgress, partial: boolean): BudgetVerdict {
  const { budget, spent, expectedByNow } = progress

  if (spent > budget) {
    return { tone: 'over', label: `over by ${moneyWhole(spent - budget)}`, tag: 'tag-alert' }
  }

  if (partial) {
    // Within the limit, but spending faster than the limit can survive. Worth
    // saying now, while there is still a period left in which to act on it.
    if (spent > expectedByNow * PACE_TOLERANCE) {
      return { tone: 'ahead', label: 'ahead of pace', tag: 'tag-warn' }
    }
    return { tone: 'on-track', label: 'on track', tag: 'tag-living' }
  }

  if (spent === 0) {
    return { tone: 'unused', label: 'nothing spent', tag: 'tag-ghost' }
  }

  return { tone: 'under', label: `under by ${moneyWhole(budget - spent)}`, tag: 'tag-living' }
}

/** Averages below this round to nothing and are noise to budget against. */
const MIN_SUGGESTION = 10

/**
 * The figure to offer as a starting point for a category, or null when its
 * recent spending is too small to be worth a line at all.
 *
 * Rounded to the nearest ten, because a budget is a decision rather than a
 * mean, and $487.31 reads as a measurement nobody chose.
 */
export function suggestedAmount(averagePerPeriod: number): number | null {
  if (averagePerPeriod < MIN_SUGGESTION) return null
  return Math.round(averagePerPeriod / 10) * 10
}

/**
 * How much of the limit is used, as a fraction, capped at 1 for drawing.
 *
 * A budget of zero is a real answer ("none of this, please"), so anything spent
 * against it is a full bar rather than a division by zero.
 */
export function usedShare(spent: number, budget: number): number {
  if (budget <= 0) return spent > 0 ? 1 : 0
  return Math.min(Math.max(spent / budget, 0), 1)
}
