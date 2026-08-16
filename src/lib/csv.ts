/**
 * A small RFC 4180 parser and the Latitude/Gem statement format.
 *
 * Akahu has no integration for the Flight Centre Mastercard, so that account
 * arrives as a CSV export. The file looks trivial and is not:
 *
 *   Date,Card Number,Description,Amount
 *   15/08/26,4542,Upper Hutt Espresso      Upper Hutt  NZL,-$6.12
 *   08/05/26,4542,"MACHA, JOM TAPAU! WELLINGTON",-$94.86
 *   23/07/26,,Payment Received - Thank You,"$1,064.02"
 *
 * Three traps: amounts over a thousand are quoted and carry a thousands
 * separator, descriptions can contain commas, and payment rows have no card
 * number. Splitting on commas gets all three wrong.
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

const REQUIRED_HEADERS = ['date', 'description', 'amount']

/**
 * Parses a Latitude/Gem export.
 *
 * Sign convention matches Akahu's without translation: a purchase is negative,
 * a payment to the card is positive. That is what lets the exclusion rules net
 * the card payment against the purchases it settles regardless of which side
 * came from which source.
 */
export function parseGemStatement(text: string): StatementRow[] {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new Error('CSV is empty')

  const header = rows[0]!.map((name) => name.trim().toLowerCase())
  const missing = REQUIRED_HEADERS.filter((name) => !header.includes(name))
  if (missing.length > 0) {
    throw new Error(
      `CSV is missing the ${missing.join(', ')} column. Found: ${header.join(', ')}`,
    )
  }

  const at = (row: string[], name: string) => row[header.indexOf(name)]?.trim() ?? ''
  const cardIndex = header.indexOf('card number')

  return rows.slice(1).flatMap((row, index): StatementRow[] => {
    const rawLine = row.join(',')
    if (row.every((cell) => cell.trim() === '')) return []

    const date = parseDate(at(row, 'date'), index + 2)
    const amount = parseAmount(at(row, 'amount'), index + 2)
    // Descriptors are padded with runs of spaces to fixed columns in the
    // statement. Collapsing them is what lets a pattern like "new world fuel"
    // match; the untouched line is preserved in the raw payload.
    const description = at(row, 'description').replace(/\s+/g, ' ').trim()

    if (description === '') throw new Error(`Line ${index + 2}: empty description`)

    return [
      {
        date,
        description,
        amount,
        cardNumber: cardIndex >= 0 ? at(row, 'card number') || null : null,
        rawLine,
        lineNumber: index + 2,
      },
    ]
  })
}

/** `15/08/26` is 15 August 2026. Day first, two-digit year. */
export function parseDate(value: string, line: number): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value)
  if (!match) throw new Error(`Line ${line}: cannot read date ${JSON.stringify(value)}, expected DD/MM/YY`)

  const [, d, m, y] = match
  const year = y!.length === 2 ? 2000 + Number(y) : Number(y)
  const month = Number(m)
  const day = Number(d)

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Line ${line}: ${value} is not a real date`)
  }

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  // Catches 31/02: the constructed date rolls forward and stops matching.
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) {
    throw new Error(`Line ${line}: ${value} is not a real date`)
  }

  return iso
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
