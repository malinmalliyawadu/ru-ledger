/**
 * A small RFC 4180 parser, and a reader for the statement CSVs New Zealand
 * banks export.
 *
 * Akahu cannot reach every account — store cards, and Rabobank's online savings
 * platform among them — so those arrive as a CSV export instead. The file looks
 * trivial and is not:
 *
 *   Date,Card Number,Description,Amount
 *   15/08/26,4542,Upper Hutt Espresso      Upper Hutt  NZL,-$6.12
 *   08/05/26,4542,"MACHA, JOM TAPAU! WELLINGTON",-$94.86
 *   23/07/26,,Payment Received - Thank You,"$1,064.02"
 *
 * Three traps in those four lines: amounts over a thousand are quoted and carry
 * a thousands separator, descriptions can contain commas, and some rows have no
 * card number. Splitting on commas gets all three wrong.
 *
 * And that is one bank. Every NZ bank names its columns differently, and
 * roughly half of them split the amount into separate debit and credit columns
 * rather than signing it. The reader below matches columns by name against a
 * list of aliases rather than by position, so a new export format is usually a
 * one-line addition instead of a new parser.
 */

/** Parses RFC 4180 text into rows, handling quoted fields and escaped quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0

  // Strip a UTF-8 BOM; exports from Windows tools routinely carry one and it
  // would otherwise become part of the first header name.
  if (text.charCodeAt(0) === 0xfeff) i = 1

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    if (row.length > 1 || row[0] !== '') rows.push(row)
    row = []
  }

  while (i < text.length) {
    const char = text[i]!

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      field += char
      i += 1
      continue
    }

    if (char === '"' && field === '') {
      quoted = true
      i += 1
      continue
    }
    if (char === ',') {
      endField()
      i += 1
      continue
    }
    if (char === '\r') {
      i += 1
      continue
    }
    if (char === '\n') {
      endRow()
      i += 1
      continue
    }

    field += char
    i += 1
  }

  if (field !== '' || row.length > 0) endRow()
  return rows
}

export type StatementRow = {
  date: string
  description: string
  amount: number
  cardNumber: string | null
  /** The original line, verbatim. The natural key hashes this, not the parsed form. */
  rawLine: string
  lineNumber: number
}

/**
 * Column aliases, in preference order. Between them these cover the exports
 * from the NZ banks and card issuers seen so far; a new one is an entry here.
 */
const HEADERS = {
  date: ['date', 'transaction date', 'processed date', 'posting date', 'value date'],
  /** A single signed column. Absent on banks that split debit and credit. */
  amount: ['amount', 'transaction amount', 'value'],
  debit: ['debit', 'debit amount', 'withdrawal', 'money out', 'paid out'],
  credit: ['credit', 'credit amount', 'deposit', 'money in', 'paid in'],
  description: ['description', 'details', 'payee', 'narrative', 'merchant', 'other party'],
  /**
   * Fields the account holder typed rather than the merchant. Appended to the
   * description when present, because on a bank transfer they are the only
   * thing that says what it was — "Details" alone is just the other person's
   * name, which no rule can categorise.
   */
  extra: ['particulars', 'code', 'reference', 'analysis code'],
  card: ['card number', 'card', 'card no'],
} as const

/**
 * Parses a statement export.
 *
 * Sign convention matches Akahu's without translation: money out is negative,
 * money in is positive. That is what lets the exclusion rules net a card
 * payment against the purchases it settles regardless of which side came from
 * which source.
 */
export function parseStatement(text: string): StatementRow[] {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new Error('That file is empty.')

  const header = rows[0]!.map((name) => name.trim().toLowerCase())
  const find = (aliases: readonly string[]) => {
    for (const alias of aliases) {
      const index = header.indexOf(alias)
      if (index >= 0) return index
    }
    return -1
  }

  const dateAt = find(HEADERS.date)
  const amountAt = find(HEADERS.amount)
  const debitAt = find(HEADERS.debit)
  const creditAt = find(HEADERS.credit)
  const descriptionAt = find(HEADERS.description)
  const cardAt = find(HEADERS.card)
  const extraAt = HEADERS.extra.map((name) => header.indexOf(name)).filter((i) => i >= 0)

  const missing: string[] = []
  if (dateAt < 0) missing.push('date')
  if (descriptionAt < 0) missing.push('description')
  if (amountAt < 0 && debitAt < 0 && creditAt < 0) missing.push('amount')

  if (missing.length > 0) {
    throw new Error(
      `That file has no ${missing.join(' or ')} column. Its columns are: ${header.join(', ')}.`,
    )
  }

  const cell = (row: string[], index: number) => (index >= 0 ? (row[index]?.trim() ?? '') : '')

  return rows.slice(1).flatMap((row, index): StatementRow[] => {
    const rawLine = row.join(',')
    if (row.every((value) => value.trim() === '')) return []

    const line = index + 2
    const date = parseDate(cell(row, dateAt), line)

    // A split statement puts the figure in exactly one of the two columns and
    // leaves the other empty, and writes both as positive numbers — the column
    // it is in *is* the sign.
    const amount =
      amountAt >= 0 && cell(row, amountAt) !== ''
        ? parseAmount(cell(row, amountAt), line)
        : signedFromColumns(cell(row, debitAt), cell(row, creditAt), line)

    // Descriptors are padded with runs of spaces to fixed columns in some
    // statements. Collapsing them is what lets a pattern like "new world fuel"
    // match; the untouched line is preserved in the raw payload either way.
    const parts = [cell(row, descriptionAt), ...extraAt.map((i) => cell(row, i))]
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter((part) => part !== '')

    // Deduplicated because banks routinely repeat the payee into Particulars,
    // and "Chorus Chorus Chorus" helps nobody.
    const description = [...new Set(parts)].join(' ')

    if (description === '') throw new Error(`Line ${line} has no description.`)

    return [
      {
        date,
        description,
        amount,
        cardNumber: cell(row, cardAt) || null,
        rawLine,
        lineNumber: line,
      },
    ]
  })
}

function signedFromColumns(debit: string, credit: string, line: number): number {
  if (debit !== '' && credit !== '') {
    throw new Error(`Line ${line} has a figure in both the debit and the credit column.`)
  }
  if (debit !== '') return -Math.abs(parseAmount(debit, line))
  if (credit !== '') return Math.abs(parseAmount(credit, line))
  throw new Error(`Line ${line} has no amount in it.`)
}

/**
 * `15/08/26` is 15 August 2026 — day first, as every NZ bank writes it.
 * `2026-08-15` is accepted too, because it is unambiguous.
 *
 * Month-first is deliberately not supported. There is no way to tell 03/04 apart
 * from 04/03, and guessing would silently move a third of every statement into
 * the wrong month rather than failing.
 */
export function parseDate(value: string, line: number): string {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(value)

  if (!iso && !dmy) {
    throw new Error(
      `Line ${line}: cannot read the date ${JSON.stringify(value)}. Expected DD/MM/YYYY or YYYY-MM-DD.`,
    )
  }

  const [, d, m, y] = iso ? [, iso[3], iso[2], iso[1]] : dmy!

  const year = y!.length === 2 ? 2000 + Number(y) : Number(y)
  const month = Number(m)
  const day = Number(d)

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Line ${line}: ${value} is not a real date.`)
  }

  const formatted = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  // Catches 31/02: the constructed date rolls forward and stops matching.
  if (new Date(`${formatted}T00:00:00Z`).toISOString().slice(0, 10) !== formatted) {
    throw new Error(`Line ${line}: ${value} is not a real date.`)
  }

  return formatted
}

/** `-$6.12`, `"$1,064.02"`, `$676.27`. Negative is money out, as with Akahu. */
export function parseAmount(value: string, line: number): number {
  const cleaned = value.replace(/[$,\s]/g, '')
  const negative = cleaned.startsWith('-') || /^\(.*\)$/.test(cleaned)
  const digits = cleaned.replace(/^[-(]|\)$/g, '')

  if (!/^\d+(\.\d+)?$/.test(digits)) {
    throw new Error(`Line ${line}: cannot read amount ${JSON.stringify(value)}`)
  }

  const amount = Number(digits)
  return negative ? -amount : amount
}
