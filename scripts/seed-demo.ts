/**
 * Generates just over a year of synthetic transactions so the app can be built,
 * reviewed and shown to Ru before Akahu is connected.
 *
 *   npm run seed:demo        (then: npm run recompute)
 *
 * Every row is written with external_id prefixed 'demo_' and raw.demo = true, so
 * it is trivially separable from real data:
 *
 *   delete from transactions_raw where external_id like 'demo_%';
 *
 * The shape is a salaried New Zealander's: net pay landing fortnightly, rent
 * weekly, a stack of monthly direct debits, a credit card settled in full each
 * month, and money moved into savings on payday. There is no gross-to-net
 * passthrough, because PAYE, KiwiSaver and student loan all come out before the
 * pay ever reaches the bank.
 *
 * It is deliberately not perfectly categorisable. A handful of descriptors are
 * left with nothing to match on, because a coverage figure that cannot fall is
 * not measuring anything.
 *
 * The window ends today rather than on a fixed date, so the current month is
 * always partly through — which is the state the dashboard is designed around,
 * and the one a fixed end date would never show.
 */

import { connect } from '../src/lib/db.ts'

// Deterministic PRNG. Re-running the seed produces the same ledger, so a UI
// change can be compared against a stable baseline.
let seed = 20260816
function random(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
const between = (lo: number, hi: number) => lo + random() * (hi - lo)
const round2 = (n: number) => Math.round(n * 100) / 100

const DAY = 86_400_000
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY)
const iso = (d: Date) => d.toISOString().slice(0, 10)

const now = new Date()
const END = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
// The first of the month, thirteen months back: twelve whole months of history
// plus the one currently running.
const START = new Date(Date.UTC(END.getUTCFullYear(), END.getUTCMonth() - 13, 1))

/**
 * Calendar-month dates, not every-30-days. Direct debits fall on a day of the
 * month, and stepping by 30 instead drifts a day or two each time until two
 * charges land inside one month and that month reads as an anomaly that never
 * happened.
 */
function monthlyDates(dayOfMonth: number, from = START, to = END): Date[] {
  const dates: Date[] = []
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), Math.min(dayOfMonth, 28)))
  while (cursor <= to) {
    if (cursor >= from) dates.push(new Date(cursor))
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return dates
}

/** Every occurrence of a weekday-anchored charge, e.g. rent every Thursday. */
function weeklyDates(from: Date, to = END): Date[] {
  const dates: Date[] = []
  for (let d = new Date(from); d <= to; d = addDays(d, 7)) dates.push(new Date(d))
  return dates
}

type Txn = { account: string; date: Date; description: string; amount: number }
const txns: Txn[] = []
const add = (account: string, date: Date, description: string, amount: number) => {
  if (date < START || date > END) return
  txns.push({ account, date, description, amount: round2(amount) })
}

// Four accounts, all reachable by Akahu. No manual CSV source here: the card is
// an ordinary bank Visa rather than a store card Akahu cannot see.
const ACCOUNTS = [
  { key: 'everyday', external_id: 'acc_demo_everyday', source: 'akahu', stale: 3, name: 'Everyday', institution: 'ANZ', type: 'CHECKING', balance: 3184.62 },
  { key: 'savings', external_id: 'acc_demo_savings', source: 'akahu', stale: 3, name: 'Serious Saver', institution: 'ANZ', type: 'SAVINGS', balance: 14_920.4 },
  { key: 'visa', external_id: 'acc_demo_visa', source: 'akahu', stale: 3, name: 'Visa', institution: 'ANZ', type: 'CREDITCARD', balance: -1263.85 },
  { key: 'sharesies', external_id: 'acc_demo_sharesies', source: 'akahu', stale: 3, name: 'Sharesies', institution: 'Sharesies', type: 'INVESTMENT', balance: 8412.7 },
] as const

// --- pay --------------------------------------------------------------------
// Net, fortnightly, on a Thursday. Nothing is deducted after this point: tax,
// KiwiSaver and student loan have already come out at source, which is the
// whole difference between this ledger and a contractor's.
const FIRST_PAYDAY = (() => {
  const d = new Date(START)
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() + 1)
  return d
})()
for (let d = new Date(FIRST_PAYDAY); d <= END; d = addDays(d, 14)) {
  add('everyday', d, 'SALARY KOWHAI HEALTH LTD', between(2750, 2850))
  // Straight into savings on payday, before it can be spent. Both legs are
  // seeded because Akahu returns both: the paying leg lands in "Savings &
  // investing", which is marked not-consumption, and the arriving leg is
  // excluded as an internal transfer so the same $300 is not netted back off.
  add('everyday', d, 'SAVE HOUSE DEPOSIT', -300)
  add('savings', d, 'TRANSFER FROM EVERYDAY 4412', 300)
}

// A tax refund and a work expense claim, so income is not one flat line.
add('everyday', addDays(END, -Math.floor(between(70, 110))), 'INLAND REVENUE REFUND', 684.2)
add('everyday', addDays(END, -Math.floor(between(20, 50))), 'KOWHAI HEALTH EXPENSE CLAIM', 143.6)
// Interest on the savings balance, so that account is not a dead row on the
// accounts page between paydays.
for (const d of monthlyDates(28)) {
  add('savings', d, 'ANZ CREDIT INTEREST', between(26, 48))
}

// --- rent -------------------------------------------------------------------
// Weekly, on a Wednesday, like most New Zealand tenancies.
const FIRST_RENT = (() => {
  const d = new Date(START)
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1)
  return d
})()
for (const d of weeklyDates(FIRST_RENT)) {
  add('everyday', d, 'RENT QUINOVIC PROPERTY MGMT', -360)
}

// --- monthly direct debits --------------------------------------------------
const MONTHLY: [string, string, number, number][] = [
  ['everyday', 'MERIDIAN ENERGY LTD', 118, 214],
  ['everyday', 'NOWNZ BROADBAND', 79, 79],
  ['everyday', 'ONE NZ LTD MOBILE', 45, 45],
  ['everyday', 'AA INSURANCE CAR', 68, 71],
  ['everyday', 'SOUTHERN CROSS HEALTH SOCIETY', 61, 61],
  ['everyday', 'SHARESIES LIMITED', 400, 400],
  ['visa', 'NETFLIX.COM', 21.99, 25.99],
  ['visa', 'SPOTIFY NZ', 17.99, 17.99],
  ['visa', 'APPLE.COM/BILL', 4.99, 24.99],
  ['visa', 'CANVA PTY LTD', 21.5, 21.5],
  ['visa', 'AUDIBLE AU', 16.45, 16.45],
]
for (const [account, description, lo, hi] of MONTHLY) {
  const dayOfMonth = 1 + Math.floor(random() * 27)
  for (const d of monthlyDates(dayOfMonth)) {
    add(account, d, description, -between(lo, hi))
  }
}

// Gym, fortnightly — the cadence detector should call this one correctly rather
// than rounding it to monthly.
for (let d = addDays(FIRST_PAYDAY, 2); d <= END; d = addDays(d, 14)) {
  add('everyday', d, 'LES MILLS WELLINGTON', -27.9)
}

// A subscription cancelled five months ago, so the bills page has something
// genuinely overdue to flag rather than only healthy series.
const CANCELLED_AT = new Date(Date.UTC(END.getUTCFullYear(), END.getUTCMonth() - 5, 12))
for (const d of monthlyDates(12, START, CANCELLED_AT)) {
  add('visa', d, 'NEON NZ STREAMING', -19.99)
}

// --- everyday spending ------------------------------------------------------
const GROCERS = ['NEW WORLD THORNDON', 'PAK N SAVE PETONE', 'WOOLWORTHS NZ 9032', 'NEW WORLD WILLIS ST', 'MOORE WILSONS FRESH']
const COFFEE = ['MOJO CUBA ST', 'FLIGHT COFFEE HANGAR', 'CUSTOMS BREW BAR CAFE', 'SWEET RELEASE CAFE', 'ALLPRESS ESPRESSO']
const EATING = [
  'UBER *EATS', 'SUSHI BAY LAMBTON', 'BURGERFUEL COURTENAY', 'DOMINOS PIZZA NZ',
  'HAPPY BOY DUMPLING', 'THAI HOUSE EXPRESS', 'FIELD & GREEN BISTRO', 'LEEDS ST BAKERY',
  'SUBWAY WILLIS ST', 'GELATO ON PARADE', 'GARAGE PROJECT BREWERY', 'THE LIBRARY BAR EATERY',
]
const TRANSPORT = ['SNAPPER SERVICES', 'UBER *TRIP', 'Z ENERGY TARANAKI ST', 'BP CONNECT NGAURANGA', 'PAYMYPARK WELLINGTON', 'WILSON PARKING WGTN']
const BEAUTY = ['MECCA MAXIMA WGTN', 'BUOY HAIR SALON', 'LUCY & THE POWDER ROOM NAILS', 'THE BODY SHOP NZ', 'BROWS BY BEC']
const CLOTHING = ['GLASSONS LAMBTON', 'COTTON ON WGTN', 'KMART LOWER HUTT', 'WITCHERY NZ', 'DECJUBA QUEENSGATE']
const HOME = ['KMART LOWER HUTT', 'BRISCOES HOMEWARES', 'MIGHTY APE NZ', 'BUNNINGS LOWER HUTT', 'SPOTLIGHT PETONE']
const HEALTH = ['UNICHEM THORNDON', 'CHEMIST WAREHOUSE NZ', 'WELLINGTON DENTAL CARE', 'SPECSAVERS QUEENSGATE']
const PETS = ['ANIMATES PETONE', 'KARORI VET CLINIC', 'PETDIRECT NZ']

for (let d = new Date(START); d <= END; d = addDays(d, 1)) {
  const dow = d.getUTCDay()

  if (dow === 6 || dow === 2) add(pick(['everyday', 'visa']), d, pick(GROCERS), -between(34, 140))
  if (dow >= 1 && dow <= 5 && random() < 0.55) add(pick(['everyday', 'visa']), d, pick(COFFEE), -between(4.5, 11))
  if (random() < 0.3) add(pick(['visa', 'everyday']), d, pick(EATING), -between(9, 58))
  if (random() < 0.18) add(pick(['everyday', 'visa']), d, pick(TRANSPORT), -between(3.2, 70))
  if (random() < 0.05) add('visa', d, pick(BEAUTY), -between(18, 160))
  if (random() < 0.045) add('visa', d, pick(CLOTHING), -between(24, 160))
  if (random() < 0.05) add(pick(['visa', 'everyday']), d, pick(HOME), -between(12, 150))
  if (random() < 0.04) add('everyday', d, pick(HEALTH), -between(11, 120))
  if (random() < 0.03) add(pick(['everyday', 'visa']), d, pick(PETS), -between(18, 180))
  if (random() < 0.018) add('everyday', d, 'ATM WITHDRAWAL ANZ', -between(20, 140))

  // Descriptors that no rule covers. Real ledgers have these.
  if (random() < 0.014) add('everyday', d, pick(['SQ *MARKET STALL', 'PAYWAVE 8812', 'ZIP CO NZ LTD', 'ONLINE PURCHASE 44107']), -between(8, 120))
  if (random() < 0.007) add('everyday', d, 'TRF ***** 8812', -between(20, 300))
}

// --- the big decisions ------------------------------------------------------
// A handful of choices across a year that explain a surprising share of the
// total, which is exactly what the big purchases page exists to surface.
const ONE_OFFS: [string, number, string, number][] = [
  ['visa', 11, 'AIR NEW ZEALAND 0864412', 642.0],
  ['visa', 10, 'MECCA MAXIMA WGTN', 384.5],
  ['everyday', 9, 'WELLINGTON DENTAL CARE', 680.0],
  ['visa', 8, 'APPLE.COM/BILL MACBOOK AIR', 2199.0],
  ['visa', 7, 'AIRBNB * HMKQ2XR', 918.4],
  ['everyday', 6, 'NZ TRANSPORT AGENCY REGO', 512.3],
  ['visa', 5, 'TICKETMASTER NZ', 428.0],
  ['everyday', 4, 'KARORI VET CLINIC', 865.2],
  ['visa', 3, 'GLASSONS LAMBTON', 312.9],
  ['visa', 2, 'JETSTAR AIRWAYS', 596.4],
  ['everyday', 1, 'BRISCOES HOMEWARES', 484.5],
]
for (const [account, monthsAgo, description, amount] of ONE_OFFS) {
  const d = new Date(Date.UTC(END.getUTCFullYear(), END.getUTCMonth() - monthsAgo, 8 + Math.floor(random() * 14)))
  add(account, d, description, -amount)
}

// --- card payments ----------------------------------------------------------
// Both legs, every month: the debit from the everyday account and the credit on
// the card. The purchases they settle are already above, so counting either leg
// would double the spend. Both are excluded as card_payment.
for (const d of monthlyDates(15, addDays(START, 20))) {
  const amount = between(700, 2400)
  add('everyday', d, 'CC PAYMENT ANZ VISA', -amount)
  add('visa', d, 'PAYMENT RECEIVED - THANK YOU', amount)
}

// --- write ------------------------------------------------------------------
txns.sort((a, b) => a.date.getTime() - b.date.getTime())

const sql = connect()
try {
  await sql.begin(async (tx) => {
    for (const account of ACCOUNTS) {
      await tx`
        insert into accounts (external_id, source, stale_after_days, name, institution, type,
                              current_balance, balance_as_at, last_synced_at, first_connected_at,
                              oldest_transaction_date, backfill_completed_at, backfill_notes)
        values (${account.external_id}, ${account.source}, ${account.stale}, ${account.name},
                ${account.institution}, ${account.type},
                ${account.balance}, ${END}, ${END}, ${START}, ${iso(START)}, ${END},
                'demo data, not from Akahu')
        on conflict (source, external_id) do update set
          current_balance  = excluded.current_balance,
          stale_after_days = excluded.stale_after_days,
          last_synced_at   = excluded.last_synced_at
      `
    }

    const accountIds = new Map(
      (
        await tx<{ id: string; external_id: string }[]>`
          select id, external_id from accounts
          where external_id = any(${ACCOUNTS.map((a) => a.external_id)})
        `
      ).map((row) => [row.external_id, row.id]),
    )

    await tx`delete from transactions_raw where external_id like 'demo_%'`

    const rows = txns.map((txn, i) => {
      const account = ACCOUNTS.find((a) => a.key === txn.account)!
      const externalId = `demo_${String(i).padStart(5, '0')}`
      return {
        external_id: externalId,
        account_id: accountIds.get(account.external_id)!,
        date: iso(txn.date),
        description: txn.description,
        amount: txn.amount,
        raw: {
          _id: externalId,
          _account: account.external_id,
          date: iso(txn.date),
          description: txn.description,
          amount: txn.amount,
          demo: true,
        },
      }
    })

    for (let i = 0; i < rows.length; i += 500) {
      await tx`insert into transactions_raw ${tx(rows.slice(i, i + 500))}`
    }
  })

  const inflow = txns.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const outflow = txns.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0)

  process.stdout.write(
    JSON.stringify({
      event: 'seed_demo.complete',
      accounts: ACCOUNTS.length,
      transactions: txns.length,
      from: iso(START),
      to: iso(END),
      gross_inflow: round2(inflow),
      gross_outflow: round2(outflow),
      note: 'run `npm run recompute` to classify',
    }) + '\n',
  )
} finally {
  await sql.end()
}
