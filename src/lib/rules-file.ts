/**
 * Parses data/categorisation-rules.json into the flat, ordered rule set that
 * both the seeder and the categorisation engine consume.
 *
 * The array order in the JSON is load-bearing (pharmacy before groceries), so
 * this module's only real job is to flatten it without losing that order and
 * to attach the two things the file expresses implicitly: which exclusion
 * reason each exclusion pattern represents, and which direction of money each
 * rule is allowed to match.
 */

export type ExclusionReason =
  | 'internal_transfer'
  | 'card_payment'
  | 'passthrough'
  | 'unidentified'

export type RuleType =
  | 'passthrough_in'
  | 'passthrough_out'
  | 'exclusion'
  | 'unidentified'
  | 'category'

export type RuleDirection = 'any' | 'inflow' | 'outflow'

export type CategoryGroup = {
  priority: number
  category: string
  patterns: string[]
}

export type RulesFile = {
  version: number
  note: string
  passthrough_in: string[]
  passthrough_out: string[]
  exclusions: string[]
  unidentified: string[]
  categories: CategoryGroup[]
  income: CategoryGroup[]
  merchant_aliases: { pattern: string; display_name: string }[]
  non_consumption_categories: string[]
  payg_merchants: string[]
}

export type SeedCategory = {
  name: string
  slug: string
  kind: 'expense' | 'income'
  isConsumption: boolean
  sortOrder: number
}

export type SeedRule = {
  priority: number
  ruleType: RuleType
  pattern: string
  appliesTo: RuleDirection
  categoryName: string | null
  categoryKind: 'expense' | 'income' | null
  exclusionReason: ExclusionReason | null
}

export type SeedAlias = {
  priority: number
  pattern: string
  displayName: string
  isPayg: boolean
}

export type SeedPlan = {
  categories: SeedCategory[]
  rules: SeedRule[]
  aliases: SeedAlias[]
  /**
   * Patterns that appear more than once with the same direction. Only the first
   * can ever fire under first-match-wins, so the rest are dropped rather than
   * loaded and left to overwrite the winner. Reported so dead config is visible
   * instead of silent.
   */
  shadowed: (SeedRule & { shadowedBy: string })[]
}

/**
 * Priority bands. Gaps of 10 within a band so a rule can be slipped between two
 * others without renumbering the world.
 *
 * The ordering between bands is the interesting part:
 *
 *   1000 passthrough   Money that lands in an account and leaves again without
 *                      ever having been Ru's to spend. A salaried employee has
 *                      none of this — PAYE, KiwiSaver and student loan are all
 *                      deducted before the pay arrives — so the band is empty
 *                      and kept only because the schema and the reconciliation
 *                      identity are shared with the version this was forked
 *                      from. Fill it in if a situation ever calls for it.
 *   2000 exclusions    Card payments and transfers between Ru's own accounts.
 *                      Must beat every category, or paying the card off would
 *                      be counted as spending on top of the purchases it
 *                      settles.
 *   3000 unidentified  Descriptors with no information ("TRF ****"). Explicitly
 *                      named rather than left to fall through, so the
 *                      uncategorised count means "a rule is missing" and
 *                      nothing else.
 *   4000 income        Inflow only. This is what separates the three patterns
 *                      that appear on both sides of the ledger.
 *   5000 categories    Expense categories, in the file's own order.
 */
const BAND = {
  passthrough: 1000,
  exclusion: 2000,
  unidentified: 3000,
  income: 4000,
  category: 5000,
} as const

/**
 * The exclusions array says what to exclude but not why, and "why" is what the
 * dashboard needs in order to explain a number. Mapped explicitly here rather
 * than inferred from the string, so changing a verdict is a one-line edit.
 */
const EXCLUSION_REASONS: Record<string, ExclusionReason> = {
  // Paying a credit card off. The purchases it settles are already counted on
  // the card, so counting the payment too would book the same money twice.
  'payment received': 'card_payment',
  'payment - thank you': 'card_payment',
  // Kiwibank's wording, which differs from the others by a hyphen.
  'payment thankyou': 'card_payment',
  'direct debit payment received': 'card_payment',
  '^cc payment': 'card_payment',
  '^credit card payment': 'card_payment',
  '^payment to card': 'card_payment',

  // A direct debit or automatic payment that bounced. Both legs land in the
  // feed, so leaving them in would show a cost that never actually happened.
  '^dd dishonour': 'internal_transfer',
  '^ap dishonour': 'internal_transfer',

  // The receiving leg of money moved into savings. The paying leg is left
  // alone: it lands in "Savings & investing", which is marked not-consumption,
  // so it is counted as money set aside rather than money spent. Excluding the
  // arriving leg is what stops the same $300 being netted straight back off
  // that total.
  //
  // This is the worked example for the rest of Ru's own-account transfers,
  // which are deliberately absent until real statements arrive: a bank writes
  // them with the account holder's own name or account number in the
  // descriptor, which is not knowable in advance, and a pattern that matches
  // too widely would silently hide real spending. Until each one is added it
  // shows up as an uncategorised row — visible, and fixable in one click.
  '^transfer from everyday': 'internal_transfer',
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseRulesFile(json: unknown): RulesFile {
  const file = json as RulesFile
  const required = [
    'passthrough_in',
    'passthrough_out',
    'exclusions',
    'unidentified',
    'categories',
    'income',
    'merchant_aliases',
  ] as const

  for (const key of required) {
    if (!Array.isArray(file[key])) {
      throw new Error(`categorisation-rules.json: "${key}" must be an array`)
    }
  }

  // A rule that will not compile is a rule that silently never matches.
  for (const { pattern } of iterateAllPatterns(file)) {
    try {
      new RegExp(pattern, 'i')
    } catch (cause) {
      throw new Error(`categorisation-rules.json: invalid regex ${JSON.stringify(pattern)}`, { cause })
    }
  }

  return file
}

function* iterateAllPatterns(file: RulesFile): Generator<{ pattern: string }> {
  for (const p of file.passthrough_in) yield { pattern: p }
  for (const p of file.passthrough_out) yield { pattern: p }
  for (const p of file.exclusions) yield { pattern: p }
  for (const p of file.unidentified) yield { pattern: p }
  for (const g of [...file.categories, ...file.income]) {
    for (const p of g.patterns) yield { pattern: p }
  }
  for (const a of file.merchant_aliases) yield { pattern: a.pattern }
}

export function buildSeedPlan(file: RulesFile): SeedPlan {
  const nonConsumption = new Set(file.non_consumption_categories ?? [])
  const payg = new Set(file.payg_merchants ?? [])

  const categories: SeedCategory[] = [
    ...file.income.map((g, i) => ({
      name: g.category,
      slug: slugify(g.category),
      kind: 'income' as const,
      isConsumption: false,
      sortOrder: i,
    })),
    ...file.categories.map((g, i) => ({
      name: g.category,
      slug: slugify(g.category),
      kind: 'expense' as const,
      isConsumption: !nonConsumption.has(g.category),
      sortOrder: i,
    })),
  ]

  const unknownNonConsumption = [...nonConsumption].filter(
    (name) => !file.categories.some((g) => g.category === name),
  )
  if (unknownNonConsumption.length > 0) {
    throw new Error(
      `non_consumption_categories names unknown categories: ${unknownNonConsumption.join(', ')}`,
    )
  }

  const rules: SeedRule[] = []
  const shadowed: (SeedRule & { shadowedBy: string })[] = []
  const seen = new Map<string, SeedRule>()

  const push = (
    band: number,
    index: number,
    rule: Omit<SeedRule, 'priority'>,
  ) => {
    const candidate: SeedRule = { ...rule, priority: band + index * 10 }
    const key = `${candidate.ruleType} ${candidate.pattern} ${candidate.appliesTo}`
    const winner = seen.get(key)
    if (winner) {
      shadowed.push({
        ...candidate,
        shadowedBy: winner.categoryName ?? winner.ruleType,
      })
      return
    }
    seen.set(key, candidate)
    rules.push(candidate)
  }

  // Passthrough, directional. The inflow leg can only ever be an inflow, and
  // pinning that down means a coincidentally similar debit cannot be swallowed.
  file.passthrough_in.forEach((pattern, i) =>
    push(BAND.passthrough, i, {
      ruleType: 'passthrough_in',
      pattern,
      appliesTo: 'inflow',
      categoryName: null,
      categoryKind: null,
      exclusionReason: 'passthrough',
    }),
  )
  file.passthrough_out.forEach((pattern, i) =>
    push(BAND.passthrough, file.passthrough_in.length + i, {
      ruleType: 'passthrough_out',
      pattern,
      appliesTo: 'outflow',
      categoryName: null,
      categoryKind: null,
      exclusionReason: 'passthrough',
    }),
  )

  file.exclusions.forEach((pattern, i) => {
    const reason = EXCLUSION_REASONS[pattern]
    if (!reason) {
      throw new Error(
        `No exclusion reason mapped for pattern ${JSON.stringify(pattern)}. ` +
          `Add it to EXCLUSION_REASONS in src/lib/rules-file.ts.`,
      )
    }
    push(BAND.exclusion, i, {
      ruleType: 'exclusion',
      pattern,
      appliesTo: 'any',
      categoryName: null,
      categoryKind: null,
      exclusionReason: reason,
    })
  })

  file.unidentified.forEach((pattern, i) =>
    push(BAND.unidentified, i, {
      ruleType: 'unidentified',
      pattern,
      appliesTo: 'any',
      categoryName: null,
      categoryKind: null,
      exclusionReason: 'unidentified',
    }),
  )

  // Income first and inflow-only; expense categories second and direction
  // agnostic. An inflow therefore gets its income category if one matches, and
  // an outflow falls straight through to the expense set. A refund from a shop
  // keeps landing in that shop's expense category, where it correctly reduces
  // the category total instead of being booked as income.
  let incomeIndex = 0
  for (const group of file.income) {
    for (const pattern of group.patterns) {
      push(BAND.income, incomeIndex++, {
        ruleType: 'category',
        pattern,
        appliesTo: 'inflow',
        categoryName: group.category,
        categoryKind: 'income',
        exclusionReason: null,
      })
    }
  }

  let categoryIndex = 0
  for (const group of file.categories) {
    for (const pattern of group.patterns) {
      push(BAND.category, categoryIndex++, {
        ruleType: 'category',
        pattern,
        appliesTo: 'any',
        categoryName: group.category,
        categoryKind: 'expense',
        exclusionReason: null,
      })
    }
  }

  const aliases: SeedAlias[] = file.merchant_aliases.map((alias, i) => ({
    priority: (i + 1) * 10,
    pattern: alias.pattern,
    displayName: alias.display_name,
    isPayg: payg.has(alias.display_name),
  }))

  const unknownPayg = [...payg].filter(
    (name) => !aliases.some((a) => a.displayName === name),
  )
  if (unknownPayg.length > 0) {
    throw new Error(
      `payg_merchants names merchants with no alias: ${unknownPayg.join(', ')}`,
    )
  }

  return { categories, rules, aliases, shadowed }
}
