'use server'

import { revalidatePath } from 'next/cache'

import { suggestedAmount } from '../lib/budget.ts'
import { db, syncDb } from '../lib/db.ts'
import { importStatementFile } from '../lib/import-statement.ts'
import { getBudget, getPeriods } from '../lib/queries.ts'
import { recompute } from '../lib/recompute.ts'
import type { ExclusionReason } from '../lib/rules-file.ts'

const EXCLUSION_REASONS: ExclusionReason[] = [
  'internal_transfer',
  'card_payment',
  'passthrough',
  'unidentified',
]

/**
 * Writes a manual verdict for one transaction.
 *
 * Only the overrides table is touched. The derived layer is left alone, because
 * the `transactions` view resolves overrides at read time — so the change shows
 * up immediately and the next recompute cannot undo it.
 */
export async function recategorise(id: string, verdict: string): Promise<void> {
  if (!id) return

  if (verdict === 'rules') {
    await db`delete from overrides where transaction_id = ${id}`
  } else if (verdict === 'include') {
    await db`
      insert into overrides (transaction_id, force_included, category_id, exclusion_reason)
      values (${id}, true, null, null)
      on conflict (transaction_id) do update set
        force_included = true, category_id = null, exclusion_reason = null
    `
  } else if (verdict.startsWith('exclude:')) {
    const reason = verdict.slice('exclude:'.length) as ExclusionReason
    if (!EXCLUSION_REASONS.includes(reason)) return
    await db`
      insert into overrides (transaction_id, exclusion_reason, category_id, force_included)
      values (${id}, ${reason}, null, false)
      on conflict (transaction_id) do update set
        exclusion_reason = ${reason}, category_id = null, force_included = false
    `
  } else if (verdict.startsWith('cat:')) {
    const categoryId = verdict.slice('cat:'.length)
    await db`
      insert into overrides (transaction_id, category_id, exclusion_reason, force_included)
      values (${id}, ${categoryId}, null, false)
      on conflict (transaction_id) do update set
        category_id = ${categoryId}, exclusion_reason = null, force_included = false
    `
  } else {
    return
  }

  revalidatePath('/', 'layout')
}

export type ImportState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'done'
      filename: string
      account: string
      rowsInFile: number
      inserted: number
      alreadyPresent: number
      from: string
      to: string
      coverage: number
      unmatched: number
    }

/**
 * Imports an uploaded statement CSV.
 *
 * Safe to run on the whole file every time: rows are keyed on a hash of the
 * original CSV line, so overlapping exports insert nothing. That matters
 * because a statement cannot be asked for "everything since last time" — every
 * export overlaps the previous one.
 */
export async function importStatement(
  _previous: ImportState,
  formData: FormData,
): Promise<ImportState> {
  const file = formData.get('file')
  const accountName = String(formData.get('accountName') ?? '').trim()

  if (!(file instanceof File) || file.size === 0) {
    return { status: 'error', message: 'Choose a CSV file to import.' }
  }
  if (accountName === '') {
    return { status: 'error', message: 'Name the account this statement belongs to.' }
  }
  if (file.size > 8_000_000) {
    return {
      status: 'error',
      message:
        'That file is over 8MB, which is far larger than a statement export. Check it is the right file.',
    }
  }

  try {
    const text = await file.text()
    // Writes the ledger, so it uses the sync connection rather than the
    // read-mostly one the pages render through.
    const result = await importStatementFile(syncDb, {
      text,
      filename: file.name,
      accountName,
    })

    // Imported rows arrive unclassified, and an unclassified transaction is
    // missing from every total on the dashboard.
    const classified = await recompute(syncDb)

    revalidatePath('/', 'layout')

    return {
      status: 'done',
      filename: file.name,
      account: result.account,
      rowsInFile: result.rowsInFile,
      inserted: result.inserted,
      alreadyPresent: result.alreadyPresent,
      from: result.from,
      to: result.to,
      coverage: classified.coverage,
      unmatched: classified.unmatched,
    }
  } catch (error) {
    // Parse errors name the line, which is the only useful thing to say about a
    // file in the wrong format.
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Writes every changed figure in a submitted budget form.
 *
 * A line is only written when the number actually changed, so re-saving an
 * untouched form adds no versions and the history stays a record of decisions
 * rather than of visits to the page.
 */
async function applyBudgetForm(periodStart: string, formData: FormData): Promise<void> {
  const categories = await db<{ id: string }[]>`
    select id from categories where kind = 'expense'
  `
  const inForce = new Map(
    (
      await db<{ category_id: string; amount: string | null; effective_from: Date }[]>`
        select category_id, amount, effective_from from budget_for_period(${periodStart})
      `
    ).map((row) => [
      row.category_id,
      {
        amount: row.amount === null ? null : Number(row.amount),
        isThisPeriod: row.effective_from.toISOString().slice(0, 10) === periodStart,
      },
    ]),
  )

  const set: { categoryId: string; amount: number }[] = []
  const cleared: string[] = []

  for (const { id } of categories) {
    const field = formData.get(`amount:${id}`)
    // Absent rather than empty: the field was not part of this form at all.
    if (field === null) continue

    const current = inForce.get(id)
    const text = String(field).replace(/[$,\s]/g, '')

    if (text === '') {
      // Blank means not budgeted. Recording that only matters when a limit is
      // in force to switch off, or when this period's own row is a tombstone
      // that may now be redundant.
      if (current !== undefined && (current.amount !== null || current.isThisPeriod)) {
        cleared.push(id)
      }
      continue
    }

    const amount = Number(text)
    if (!Number.isFinite(amount) || amount < 0) continue

    const rounded = Math.round(amount * 100) / 100
    if (current?.amount === rounded) continue

    set.push({ categoryId: id, amount: rounded })
  }

  if (set.length === 0 && cleared.length === 0) return

  await db.begin(async (tx) => {
    for (const line of set) {
      await tx`
        insert into budget_lines (category_id, effective_from, amount)
        values (${line.categoryId}, ${periodStart}, ${line.amount})
        on conflict (category_id, effective_from) do update set amount = excluded.amount
      `
    }

    for (const categoryId of cleared) {
      // Drop this period's own line first, then write a tombstone only if an
      // older line would otherwise show through. Clearing a limit set in this
      // same period therefore leaves no row at all, rather than a null that
      // says nothing.
      await tx`
        delete from budget_lines
        where category_id = ${categoryId} and effective_from = ${periodStart}
      `
      await tx`
        insert into budget_lines (category_id, effective_from, amount)
        select ${categoryId}, ${periodStart}, null
        where exists (
          select 1 from budget_for_period(${periodStart}) b
          where b.category_id = ${categoryId} and b.amount is not null
        )
      `
    }
  })
}

/**
 * Saves the budget for a period.
 *
 * Editing while an older period is selected is meaningful and supported: the
 * line takes effect from that period and every period after it, up to the next
 * line that supersedes it.
 */
export async function saveBudget(formData: FormData): Promise<void> {
  // Only a real period start, so a hand-edited form cannot anchor a line to a
  // date no period ever begins on.
  const periodStart = String(formData.get('periodStart') ?? '')
  const periods = await getPeriods()
  if (!periods.some((period) => period.start === periodStart)) return

  await applyBudgetForm(periodStart, formData)
  revalidatePath('/', 'layout')
}

/**
 * Fills every category that has no budget yet with what it has actually been
 * costing, rounded to the nearest ten.
 *
 * Starting from a blank grid of twenty categories is the reason budgets do not
 * get written. Starting from what the last six periods actually cost turns it
 * into editing a handful of figures.
 *
 * Anything already carrying a decision is left alone, including categories
 * deliberately switched off and figures typed into the form but not yet saved,
 * which are written first. This fills blanks and never overwrites a judgement,
 * so it is always safe to press.
 */
export async function seedBudgetFromAverages(formData: FormData): Promise<void> {
  const periodStart = String(formData.get('periodStart') ?? '')
  const periods = await getPeriods()
  const period = periods.find((p) => p.start === periodStart)
  if (!period) return

  await applyBudgetForm(periodStart, formData)

  const decided = new Set(
    (
      await db<{ category_id: string }[]>`
        select category_id from budget_for_period(${periodStart})
      `
    ).map((row) => row.category_id),
  )

  // Same averages the editor shows as a hint, from the same query, so the
  // button cannot suggest one figure while the page displays another.
  const { lines } = await getBudget(periodStart, period.elapsedDays, period.totalDays)

  const seeds = lines
    .filter((line) => !decided.has(line.categoryId))
    .map((line) => ({ categoryId: line.categoryId, amount: suggestedAmount(line.averagePerPeriod) }))
    .filter((seed): seed is { categoryId: string; amount: number } => seed.amount !== null)

  if (seeds.length === 0) return

  await db.begin(async (tx) => {
    for (const seed of seeds) {
      await tx`
        insert into budget_lines (category_id, effective_from, amount)
        values (${seed.categoryId}, ${periodStart}, ${seed.amount})
        on conflict (category_id, effective_from) do update set amount = excluded.amount
      `
    }
  })

  revalidatePath('/', 'layout')
}

/**
 * Which day of the month a statement period opens on.
 *
 * Capped at 28 by the database, because 29 to 31 do not exist in every month
 * and any of them would produce periods that skip or double up.
 */
export async function setStatementStartDay(formData: FormData): Promise<void> {
  const day = Number(formData.get('statementStartDay'))
  if (!Number.isInteger(day) || day < 1 || day > 28) return

  await db`update settings set statement_start_day = ${day} where id`
  revalidatePath('/', 'layout')
}

/** The large-purchase threshold. What counts as a decision rather than a habit. */
export async function setThreshold(formData: FormData): Promise<void> {
  const value = Number(formData.get('threshold'))
  if (!Number.isFinite(value) || value <= 0) return

  await db`update settings set large_purchase_threshold = ${value} where id`
  revalidatePath('/', 'layout')
}
