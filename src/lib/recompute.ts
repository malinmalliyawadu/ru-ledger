/**
 * Rebuilds transactions_enriched from transactions_raw + rules + aliases.
 *
 * A library function rather than only a script, because the daily sync has to
 * run it too — a sync that fetched new transactions but left them unclassified
 * would show a dashboard that quietly understates everything.
 *
 * Manual overrides are not consulted: the `transactions` view applies them at
 * read time, so this cannot overwrite one.
 */

import type postgres from 'postgres'

import { categorise, compileAliases, compileRules } from './categorise.ts'
import { detectRecurring } from './recurring.ts'
import type { ExclusionReason, RuleDirection, RuleType } from './rules-file.ts'
import { nzToday } from './time.ts'

export type RecomputeResult = {
  transactions: number
  rules: number
  unmatched: number
  coverage: number
  recurringSeries: number
  largePurchases: number
  threshold: number
  unmatchedSamples: string[]
}

export async function recompute(sql: postgres.Sql): Promise<RecomputeResult> {
  const [settings] = await sql<{ large_purchase_threshold: string }[]>`
    select large_purchase_threshold from settings limit 1
  `
  const threshold = Number(settings?.large_purchase_threshold ?? 500)

  const ruleRows = await sql<
    {
      id: string
      priority: number
      rule_type: RuleType
      pattern: string
      applies_to: RuleDirection
      category_id: string | null
      exclusion_reason: ExclusionReason | null
    }[]
  >`
    select id, priority, rule_type, pattern, applies_to, category_id, exclusion_reason
    from rules where enabled order by priority, id
  `

  const aliasRows = await sql<
    { id: string; priority: number; pattern: string; display_name: string; is_payg: boolean }[]
  >`select id, priority, pattern, display_name, is_payg from merchant_aliases where enabled`

  const txns = await sql<
    { id: string; date: Date; description: string; amount: string }[]
  >`select id, date, description, amount from transactions_raw order by date, id`

  const rules = compileRules(
    ruleRows.map((r) => ({
      id: r.id,
      priority: r.priority,
      ruleType: r.rule_type,
      pattern: r.pattern,
      appliesTo: r.applies_to,
      categoryId: r.category_id,
      exclusionReason: r.exclusion_reason,
    })),
  )

  const aliases = compileAliases(
    aliasRows.map((a) => ({
      id: a.id,
      priority: a.priority,
      pattern: a.pattern,
      displayName: a.display_name,
      isPayg: a.is_payg,
    })),
  )

  const verdicts = txns.map((txn) => ({
    txn,
    amount: Number(txn.amount),
    verdict: categorise({ description: txn.description, amount: Number(txn.amount) }, rules, aliases),
  }))

  // Cadence is detected over real spending only. Excluded rows are the same
  // money seen twice, and counting them would invent a rhythm.
  // Transaction dates are calendar days pegged at UTC midnight, so the fallback
  // has to be pegged the same way rather than being the current instant, or a
  // gap measured against it is out by the offset.
  const asOf = txns.at(-1)?.date ?? new Date(`${nzToday()}T00:00:00Z`)
  const series = detectRecurring(
    verdicts
      .filter((v) => v.verdict.exclusionReason === null && v.amount < 0)
      .map((v) => ({ merchant: v.verdict.merchantDisplayName, date: v.txn.date, amount: v.amount })),
    asOf,
  )

  const recurrenceByMerchant = new Map(series.map((s) => [s.merchant, s.medianGapDays]))

  const rows = verdicts.map(({ txn, amount, verdict }) => {
    const recurrenceDays = recurrenceByMerchant.get(verdict.merchantDisplayName) ?? null
    const isRecurring = recurrenceDays !== null && verdict.exclusionReason === null && amount < 0

    return {
      transaction_id: txn.id,
      category_id: verdict.categoryId,
      merchant_display_name: verdict.merchantDisplayName,
      exclusion_reason: verdict.exclusionReason,
      is_recurring: isRecurring,
      is_payg: verdict.isPayg,
      // A large purchase is a decision, not a habit: a one-off big spend, not
      // the monthly rent-sized thing you already know about.
      is_one_off:
        !isRecurring &&
        verdict.exclusionReason === null &&
        amount < 0 &&
        Math.abs(amount) >= threshold,
      recurrence_days: isRecurring ? Math.round(recurrenceDays!) : null,
      rule_id: verdict.ruleId,
      alias_id: verdict.aliasId,
      classified_by: verdict.classifiedBy,
    }
  })

  await sql.begin(async (tx) => {
    await tx`truncate transactions_enriched`
    for (let i = 0; i < rows.length; i += 500) {
      await tx`insert into transactions_enriched ${tx(rows.slice(i, i + 500))}`
    }
  })

  const unmatched = rows.filter((r) => r.classified_by === 'unmatched')

  return {
    transactions: rows.length,
    rules: rules.length,
    unmatched: unmatched.length,
    coverage: rows.length === 0 ? 1 : 1 - unmatched.length / rows.length,
    recurringSeries: series.length,
    largePurchases: rows.filter((r) => r.is_one_off).length,
    threshold,
    unmatchedSamples: [...new Set(unmatched.map((r) => r.merchant_display_name ?? ''))].slice(0, 20),
  }
}
