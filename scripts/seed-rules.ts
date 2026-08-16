/**
 * Seeds categories, rules and merchant aliases from data/categorisation-rules.json.
 *
 * Idempotent: rules are keyed on (rule_type, pattern, applies_to), so re-running
 * updates in place and rule ids referenced by transactions_enriched stay stable.
 * Seeded rules that have disappeared from the JSON are disabled rather than
 * deleted, which keeps historical rule_id references intact.
 *
 *   npm run seed:rules
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { connect } from '../src/lib/db.ts'
import { buildSeedPlan, parseRulesFile } from '../src/lib/rules-file.ts'

const SEED_SOURCE = 'seed:categorisation-rules.json'

const rulesPath = fileURLToPath(
  new URL('../data/categorisation-rules.json', import.meta.url),
)

const file = parseRulesFile(JSON.parse(readFileSync(rulesPath, 'utf8')))
const plan = buildSeedPlan(file)
const sql = connect()

try {
  await sql.begin(async (tx) => {
    // --- categories ---------------------------------------------------------
    for (const category of plan.categories) {
      await tx`
        insert into categories (name, slug, kind, is_consumption, sort_order)
        values (${category.name}, ${category.slug}, ${category.kind},
                ${category.isConsumption}, ${category.sortOrder})
        on conflict (kind, name) do update set
          slug           = excluded.slug,
          is_consumption = excluded.is_consumption,
          sort_order     = excluded.sort_order
      `
    }

    const categoryRows = await tx<{ id: string; name: string; kind: string }[]>`
      select id, name, kind from categories
    `
    const categoryIds = new Map(
      categoryRows.map((row) => [`${row.kind}:${row.name}`, row.id]),
    )

    // --- rules --------------------------------------------------------------
    for (const rule of plan.rules) {
      const categoryId = rule.categoryName
        ? categoryIds.get(`${rule.categoryKind}:${rule.categoryName}`)
        : null

      if (rule.categoryName && !categoryId) {
        throw new Error(`No category row for ${rule.categoryKind}:${rule.categoryName}`)
      }

      await tx`
        insert into rules (priority, rule_type, pattern, applies_to,
                           category_id, exclusion_reason, source, enabled)
        values (${rule.priority}, ${rule.ruleType}, ${rule.pattern}, ${rule.appliesTo},
                ${categoryId ?? null}, ${rule.exclusionReason}, ${SEED_SOURCE}, true)
        on conflict (rule_type, pattern, applies_to) do update set
          priority         = excluded.priority,
          category_id      = excluded.category_id,
          exclusion_reason = excluded.exclusion_reason,
          source           = excluded.source,
          enabled          = true
      `
    }

    // Retire seeded rules the JSON no longer contains. Manually created rules
    // (source = 'manual') are left alone.
    const seededKeys = plan.rules.map(
      (r) => `${r.ruleType}|${r.pattern}|${r.appliesTo}`,
    )
    const retired = await tx<{ pattern: string }[]>`
      update rules set enabled = false
      where source = ${SEED_SOURCE}
        and enabled
        and rule_type || '|' || pattern || '|' || applies_to <> all(${seededKeys})
      returning pattern
    `

    // --- merchant aliases ---------------------------------------------------
    for (const alias of plan.aliases) {
      await tx`
        insert into merchant_aliases (priority, pattern, display_name, is_payg)
        values (${alias.priority}, ${alias.pattern}, ${alias.displayName}, ${alias.isPayg})
        on conflict (pattern) do update set
          priority     = excluded.priority,
          display_name = excluded.display_name,
          is_payg      = excluded.is_payg,
          enabled      = true
      `
    }

    log({
      event: 'seed.complete',
      categories: plan.categories.length,
      expense_categories: plan.categories.filter((c) => c.kind === 'expense').length,
      income_categories: plan.categories.filter((c) => c.kind === 'income').length,
      rules: plan.rules.length,
      aliases: plan.aliases.length,
      shadowed: plan.shadowed.length,
      retired: retired.length,
    })

    for (const rule of plan.shadowed) {
      log({
        event: 'seed.shadowed_pattern',
        pattern: rule.pattern,
        would_have_been: rule.categoryName,
        already_claimed_by: rule.shadowedBy,
        note: 'dropped: an earlier rule with the same pattern and direction always wins',
      })
    }
    for (const rule of retired) {
      log({ event: 'seed.retired_rule', pattern: rule.pattern })
    }
  })
} finally {
  await sql.end()
}

function log(fields: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(fields) + '\n')
}
