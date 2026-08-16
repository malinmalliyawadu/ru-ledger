/**
 * The categorisation engine.
 *
 * Pure: rules and aliases in, a verdict out. No database, no clock, no I/O, so
 * the coverage test can run it over a fixture and the recompute script can run
 * it over 1,256 rows without either needing the other.
 */

import type { ExclusionReason, RuleDirection, RuleType } from './rules-file.ts'

export type CompiledRule = {
  id: string
  priority: number
  ruleType: RuleType
  pattern: string
  regex: RegExp
  appliesTo: RuleDirection
  categoryId: string | null
  exclusionReason: ExclusionReason | null
}

export type CompiledAlias = {
  id: string
  regex: RegExp
  displayName: string
  isPayg: boolean
}

export type Verdict = {
  categoryId: string | null
  exclusionReason: ExclusionReason | null
  ruleId: string | null
  aliasId: string | null
  merchantDisplayName: string
  isPayg: boolean
  classifiedBy: 'rule' | 'override' | 'unmatched'
}

export type RuleRow = Omit<CompiledRule, 'regex'>
export type AliasRow = Omit<CompiledAlias, 'regex'> & { pattern: string }

export function compileRules(rows: (RuleRow & { pattern: string })[]): CompiledRule[] {
  return rows
    .map((row) => ({ ...row, regex: new RegExp(row.pattern, 'i') }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
}

export function compileAliases(rows: (AliasRow & { priority: number })[]): CompiledAlias[] {
  return rows
    .slice()
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map((row) => ({
      id: row.id,
      regex: new RegExp(row.pattern, 'i'),
      displayName: row.displayName,
      isPayg: row.isPayg,
    }))
}

/**
 * Money in or money out. This is what separates the patterns that appear on
 * both sides of the ledger: `sharesies` as an outflow is investing, as an
 * inflow it is a withdrawal.
 */
export function directionOf(amount: number): 'inflow' | 'outflow' {
  return amount >= 0 ? 'inflow' : 'outflow'
}

/**
 * Rules only. Manual overrides are applied by the `transactions` view at read
 * time, which is why this function has no idea they exist — a recompute
 * physically cannot clobber one.
 */
export function categorise(
  txn: { description: string; amount: number },
  rules: CompiledRule[],
  aliases: CompiledAlias[],
): Verdict {
  const direction = directionOf(txn.amount)
  const description = txn.description ?? ''

  // First enabled rule whose pattern matches and whose direction admits this
  // transaction. Order is everything: exclusions sit above every category, so
  // paying the Amex off never lands in a spending bucket.
  const matched = rules.find(
    (rule) =>
      (rule.appliesTo === 'any' || rule.appliesTo === direction) &&
      rule.regex.test(description),
  )

  const alias = aliases.find((a) => a.regex.test(description))

  return {
    categoryId: matched?.categoryId ?? null,
    exclusionReason: matched?.exclusionReason ?? null,
    ruleId: matched?.id ?? null,
    aliasId: alias?.id ?? null,
    merchantDisplayName: alias?.displayName ?? cleanDescription(description),
    isPayg: alias?.isPayg ?? false,
    classifiedBy: matched ? 'rule' : 'unmatched',
  }
}

/**
 * Fallback display name for descriptors with no alias. Strips the reference
 * noise banks staple onto a merchant name so the transactions table is
 * readable, without pretending to know the real trading name.
 */
/**
 * Tokens that are initialisms, not words, and look wrong title-cased.
 *
 * Listed explicitly rather than inferred. The tempting shortcut — "a short
 * token with no vowel in it is a set of initials" — gets BNZ and TSB right and
 * then shouts NEW WORLD WILLIS ST as WILLIS ST, turns Ltd into LTD, and does
 * the same to Rd, Mt, Dr and Mgmt. Those appear at least as often as the banks
 * do, so the rule costs more than it earns. A list is dull, but it is only ever
 * wrong in the direction of leaving something title-cased, which is the
 * survivable mistake.
 */
const ACRONYMS = new Set([
  // places and currencies
  'nz', 'nzd', 'uk', 'usa', 'eu', 'aus',
  // banks and financial institutions
  'anz', 'asb', 'bnz', 'tsb', 'sbs', 'nzhl', 'hsbc', 'amex',
  // government and tax
  'ird', 'gst', 'paye', 'acc', 'nzta', 'vtnz', 'wof',
  // payment machinery
  'atm', 'atms', 'eft', 'eftpos', 'ap', 'dd', 'pos',
  // company suffixes that really are initials
  'llc', 'plc',
  // merchants written as initials
  'aa', 'bp', 'kfc', 'jb', 'pb', 'npd', 'spca', 'ymca',
])

export function cleanDescription(description: string): string {
  const cleaned = description
    .replace(/\s{2,}/g, ' ')
    .replace(/\b(?:card|c\/card|eftpos)\s*\d{2,}\b/gi, '')
    .replace(/\b\d{2}[-/]\d{2}[-/]\d{2,4}\b/g, '')
    // NZ bank account numbers, e.g. 38-9014-0271553-01. Identifying, not
    // informative, and they make an otherwise readable label unreadable.
    .replace(/\b\d{2}-\d{3,4}-\d{6,8}-\d{2,3}\b/g, '')
    // The trailing \b is load-bearing. Without it "ref" matches the front of
    // REFUND and the \S+ eats the rest, so "IRD REFUND" arrives as "IRD" — a
    // word silently deleted from the one place a reader is looking for it.
    .replace(/\b(?:ref|reference|particulars|code)\b[:.]?\s*\S+/gi, '')
    .replace(/\s*[-;,]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const base = cleaned || description.trim()

  // Bank descriptors are shouted. Title case reads better in a table, but leave
  // anything already mixed case alone, since that casing was deliberate.
  if (base !== base.toUpperCase()) return base

  return base
    .toLowerCase()
    .replace(/\b[a-z][a-z'’]*/g, (word) =>
      ACRONYMS.has(word) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1),
    )
    // Domains read as domains, not as sentences.
    .replace(/\.(Com|Co|Nz|Ai|Io|Org|Net|Dev)\b/g, (match) => match.toLowerCase())
}
