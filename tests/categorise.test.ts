/**
 * Unit tests for the engine. No database: rules in, verdict out.
 *
 * These assert the behaviours that are easy to break by reordering the rules
 * file, and that a coverage percentage would not notice — a rule set can be
 * 100% covered and still put every pharmacy purchase in groceries.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { categorise, cleanDescription, compileAliases, compileRules } from '../src/lib/categorise.ts'
import { buildSeedPlan, parseRulesFile } from '../src/lib/rules-file.ts'

const file = parseRulesFile(
  JSON.parse(readFileSync(fileURLToPath(new URL('../data/categorisation-rules.json', import.meta.url)), 'utf8')),
)
const plan = buildSeedPlan(file)

// Stand-in ids: the engine only cares that categories are distinguishable.
const rules = compileRules(
  plan.rules.map((rule, i) => ({
    id: String(i).padStart(4, '0'),
    priority: rule.priority,
    ruleType: rule.ruleType,
    pattern: rule.pattern,
    appliesTo: rule.appliesTo,
    categoryId: rule.categoryName,
    exclusionReason: rule.exclusionReason,
  })),
)

const aliases = compileAliases(
  plan.aliases.map((alias, i) => ({
    id: `a${i}`,
    priority: alias.priority,
    pattern: alias.pattern,
    displayName: alias.displayName,
    isPayg: alias.isPayg,
  })),
)

const classify = (description: string, amount: number) =>
  categorise({ description, amount }, rules, aliases)

test('order is load-bearing: pharmacy beats groceries', () => {
  // "New World Chemist" style descriptors are exactly why the pharmacy band
  // sits ahead of the grocery one.
  assert.equal(classify('UNICHEM THORNDON PHARMACY', -32).categoryId, 'Health & pharmacy')
  assert.equal(classify('NEW WORLD WILLIS ST', -84).categoryId, 'Groceries')
})

test('order is load-bearing: coffee beats eating out', () => {
  // Both bands would happily claim a cafe. Coffee sits first because a $5 flat
  // white every morning is a different habit from a $60 dinner, and folding
  // them together hides the one that is easiest to act on.
  assert.equal(classify('CUSTOMS BREW BAR CAFE', -5.5).categoryId, 'Coffee')
  assert.equal(classify('FIELD & GREEN BISTRO', -62).categoryId, 'Eating out & takeaways')
})

test('exclusions beat every spending category', () => {
  const verdict = classify('CC PAYMENT ANZ VISA', -1400)
  assert.equal(verdict.exclusionReason, 'card_payment')
  assert.equal(verdict.categoryId, null, 'an excluded row must not also carry a category')
})

test('the card payment on both sides of the ledger is excluded', () => {
  // The debit leaving the everyday account and the credit landing on the card
  // are the same money. Counting either as spending would double the month.
  assert.equal(classify('CC PAYMENT ANZ VISA', -1400).exclusionReason, 'card_payment')
  assert.equal(classify('PAYMENT RECEIVED - THANK YOU', 1400).exclusionReason, 'card_payment')
})

test('a salary is income, not a passthrough', () => {
  // The contracting version of this app has a passthrough band at the top of
  // the rule set for gross pay that immediately leaves again. An employee's pay
  // has already had tax, KiwiSaver and student loan taken out of it, so it is
  // simply income — and the passthrough band is empty on purpose.
  const pay = classify('SALARY KOWHAI HEALTH LTD', 2800)
  assert.equal(pay.categoryId, 'Salary')
  assert.equal(pay.exclusionReason, null)
})

test('direction separates the patterns that appear on both sides', () => {
  assert.equal(classify('SHARESIES LIMITED', -400).categoryId, 'Savings & investing')
  assert.equal(classify('SHARESIES LIMITED', 400).categoryId, 'Investment withdrawals')

  assert.equal(classify('ANZ CREDIT INTEREST', 38).categoryId, 'Interest earned')
  assert.equal(classify('INTEREST CHARGE ON PURCHASES', -12.4).categoryId, 'Fees & interest')
})

test('a refund stays in the category it was spent from', () => {
  // Positive amount, no income rule matches, so it lands back in the expense
  // category where it correctly reduces the total rather than inflating income.
  const verdict = classify('GLASSONS LAMBTON', 89.99)
  assert.equal(verdict.categoryId, 'Clothing')
  assert.equal(verdict.exclusionReason, null)
})

test('money put away is a category, not an exclusion', () => {
  // It genuinely left the account, so it must stay in the ledger and reconcile.
  // What keeps it out of the spending figure is is_consumption on the category,
  // not an exclusion — see non_consumption_categories in the rules file.
  const saving = classify('SAVE HOUSE DEPOSIT', -300)
  assert.equal(saving.categoryId, 'Savings & investing')
  assert.equal(saving.exclusionReason, null)
})

test('the receiving leg of a savings transfer is excluded', () => {
  // Otherwise the same $300 is netted straight back off the savings total and
  // a month of putting money aside reads as nothing at all.
  assert.equal(classify('TRANSFER FROM EVERYDAY 4412', 300).exclusionReason, 'internal_transfer')
})

test('rent beats every other outflow', () => {
  // Rent is the single biggest line in the ledger and lands weekly. It sits
  // first so nothing else can claim it.
  assert.equal(classify('RENT QUINOVIC PROPERTY MGMT', -360).categoryId, 'Rent')
})

test('aliases resolve descriptor drift to one merchant', () => {
  assert.equal(classify('PAK N SAVE PETONE', -96).merchantDisplayName, "Pak'nSave")
  assert.equal(classify('PAKNSAVE KILBIRNIE', -104).merchantDisplayName, "Pak'nSave")
  assert.equal(classify('WOOLWORTHS NZ 9032', -71).merchantDisplayName, 'Woolworths')
  assert.equal(classify('COUNTDOWN JOHNSONVILLE', -71).merchantDisplayName, 'Woolworths')
})

test('unmatched descriptors are reported, not silently bucketed', () => {
  const verdict = classify('SQ *SOME MARKET STALL', -22)
  assert.equal(verdict.classifiedBy, 'unmatched')
  assert.equal(verdict.categoryId, null)
  assert.equal(verdict.exclusionReason, null)
})

test('a descriptor carrying no information is named, not left unmatched', () => {
  // Explicitly excluded as "unidentified" so the still-to-sort count means "a
  // rule is missing" and nothing else.
  assert.equal(classify('TRF ***** 8812', -140).exclusionReason, 'unidentified')
})

test('descriptors clean up without inventing a merchant name', () => {
  assert.equal(cleanDescription('RENT QUINOVIC PROPERTY MGMT'), 'Rent Quinovic Property Mgmt')
  assert.equal(cleanDescription('APPLE.COM/BILL'), 'Apple.com/Bill')
  // Deliberate mixed case is left alone.
  assert.equal(cleanDescription('iTunes Store'), 'iTunes Store')
})

test('initialisms are not title-cased into words', () => {
  // "Aa Insurance" and "Anz Credit Interest" are the bugs this catches. Both
  // appear on the demo ledger, so both would have shipped.
  assert.equal(cleanDescription('AA INSURANCE CAR'), 'AA Insurance Car')
  assert.equal(cleanDescription('ANZ CREDIT INTEREST'), 'ANZ Credit Interest')
  assert.equal(cleanDescription('BNZ BRANCH FEE'), 'BNZ Branch Fee')
  assert.equal(cleanDescription('IRD INCOME TAX'), 'IRD Income Tax')
})

test('abbreviations that are words stay title-cased', () => {
  // The reason the list above is a list rather than a "short and vowelless"
  // rule: every one of these would be shouted by it.
  assert.equal(cleanDescription('PROPERTY MGMT LTD'), 'Property Mgmt Ltd')
  assert.equal(cleanDescription('NEW WORLD WILLIS ST'), 'New World Willis St')
  assert.equal(cleanDescription('MT VICTORIA DAIRY'), 'Mt Victoria Dairy')
})

test('reference stripping does not eat the word refund', () => {
  // "ref" without a trailing word boundary matches the front of REFUND, and
  // the reference-stripping rule then swallows the rest of it.
  assert.equal(cleanDescription('INLAND REVENUE REFUND'), 'Inland Revenue Refund')
  // The thing it is actually meant to strip still goes.
  assert.equal(cleanDescription('NEW WORLD REF 88213'), 'New World')
})
