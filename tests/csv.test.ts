/**
 * Statement parsing. No database.
 *
 * Every NZ bank names its columns differently and about half of them split the
 * amount into debit and credit rather than signing it, so the reader matches
 * columns by name against a list of aliases. These tests pin the formats it
 * claims to understand — a parser that silently reads the wrong column produces
 * a plausible ledger that is wrong, which is worse than one that fails.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseAmount, parseCsv, parseDate, parseStatement } from '../src/lib/csv.ts'

test('quoted fields survive commas, thousands separators and escaped quotes', () => {
  const rows = parseCsv('a,b\n"x, y","$1,064.02"\n"she said ""hi""",2\n')
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x, y', '$1,064.02'],
    ['she said "hi"', '2'],
  ])
})

test('a UTF-8 BOM does not become part of the first column name', () => {
  const rows = parseCsv('﻿Date,Amount\n01/02/2026,1\n')
  assert.equal(rows[0]![0], 'Date')
})

test('a signed amount column, as a card issuer writes it', () => {
  const rows = parseStatement(
    'Date,Card Number,Description,Amount\n' +
      '15/08/26,4542,Kaffee Eis      Wellington  NZL,-$6.12\n' +
      '23/07/26,,Payment Received - Thank You,"$1,064.02"\n',
  )

  assert.equal(rows.length, 2)
  assert.deepEqual(
    { ...rows[0], rawLine: undefined },
    {
      date: '2026-08-15',
      description: 'Kaffee Eis Wellington NZL',
      amount: -6.12,
      cardNumber: '4542',
      lineNumber: 2,
      rawLine: undefined,
    },
  )
  assert.equal(rows[1]!.amount, 1064.02)
  assert.equal(rows[1]!.cardNumber, null)
})

test('separate debit and credit columns, as most NZ banks write them', () => {
  // Both are written positive; the column a figure sits in is the sign.
  const rows = parseStatement(
    'Date,Details,Debit,Credit\n' +
      '2026-08-15,New World Thorndon,84.20,\n' +
      '2026-08-16,Salary Kowhai Health,,2800.00\n',
  )

  assert.equal(rows[0]!.amount, -84.2, 'a debit is money out')
  assert.equal(rows[1]!.amount, 2800, 'a credit is money in')
})

test('a figure in both the debit and the credit column is refused', () => {
  assert.throws(
    () => parseStatement('Date,Details,Debit,Credit\n2026-08-15,Odd,10.00,10.00\n'),
    /both the debit and the credit column/,
  )
})

test('particulars and reference are appended, because Details alone says nothing', () => {
  // On a bank transfer, Details is the other party's name and the thing that
  // says what it was for is in the columns beside it.
  const rows = parseStatement(
    'Type,Details,Particulars,Code,Amount,Date\n' +
      'Transfer,J Smith,Flat power,Aug,-62.50,15/08/2026\n',
  )
  assert.equal(rows[0]!.description, 'J Smith Flat power Aug')
})

test('a repeated payee is not stuttered back', () => {
  const rows = parseStatement(
    'Date,Details,Particulars,Amount\n15/08/2026,Chorus,Chorus,-79.00\n',
  )
  assert.equal(rows[0]!.description, 'Chorus')
})

test('a missing column names itself and lists what was actually found', () => {
  assert.throws(
    () => parseStatement('When,What,How much\n01/02/2026,Coffee,-5\n'),
    /no date or description or amount column.*when, what, how much/is,
  )
})

test('dates are day-first, and ISO is accepted', () => {
  assert.equal(parseDate('15/08/26', 1), '2026-08-15')
  assert.equal(parseDate('15/08/2026', 1), '2026-08-15')
  assert.equal(parseDate('15-08-2026', 1), '2026-08-15')
  assert.equal(parseDate('2026-08-15', 1), '2026-08-15')
})

test('an impossible date fails rather than rolling forward', () => {
  // Without the round-trip check, 31/02 quietly becomes 3 March.
  assert.throws(() => parseDate('31/02/2026', 7), /not a real date/)
  assert.throws(() => parseDate('15/13/2026', 7), /not a real date/)
})

test('an unreadable date says so instead of guessing', () => {
  assert.throws(() => parseDate('Aug 15 2026', 7), /cannot read the date/)
})

test('amounts read in every shape a bank writes them', () => {
  assert.equal(parseAmount('-$6.12', 1), -6.12)
  assert.equal(parseAmount('$1,064.02', 1), 1064.02)
  assert.equal(parseAmount('676.27', 1), 676.27)
  // Accountants' negative.
  assert.equal(parseAmount('(42.00)', 1), -42)
})
