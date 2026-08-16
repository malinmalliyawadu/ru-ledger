# Schema and the reasoning behind it

## The shape

```mermaid
erDiagram
    accounts            ||--o{ transactions_raw      : holds
    transactions_raw    ||--o| transactions_enriched : "derived, 1:1"
    transactions_raw    ||--o| overrides             : "manual verdict, 0:1"
    categories          ||--o{ rules                 : "a category rule assigns"
    categories          ||--o{ transactions_enriched : classifies
    categories          ||--o{ overrides             : classifies
    categories          ||--o{ budget_lines          : "is limited by"
    rules               ||--o{ transactions_enriched : "matched by"
    merchant_aliases    ||--o{ transactions_enriched : "named by"

    accounts {
        uuid   id PK
        text   akahu_id UK
        text   name
        text   institution
        numeric current_balance
        date   oldest_transaction_date "how far back Akahu actually went"
        timestamptz last_synced_at
    }
    transactions_raw {
        uuid   id PK
        text   akahu_id UK "natural key for idempotent upsert"
        uuid   account_id FK
        date   date
        text   description
        numeric amount "Akahu sign: negative = money out"
        jsonb  raw
        timestamptz revised_at "set only on a genuine upstream change"
    }
    transactions_enriched {
        uuid   transaction_id PK_FK
        uuid   category_id FK "null when excluded"
        text   merchant_display_name
        enum   exclusion_reason "null when categorised"
        bool   is_recurring
        bool   is_payg
        bool   is_one_off
        int    recurrence_days
        uuid   rule_id FK
        uuid   alias_id FK
        enum   classified_by "rule | override | unmatched"
    }
    rules {
        uuid   id PK
        int    priority "evaluation order, gaps of 10"
        enum   rule_type "passthrough_in|passthrough_out|exclusion|unidentified|category"
        text   pattern "case-insensitive regex"
        enum   applies_to "any | inflow | outflow"
        uuid   category_id FK
        enum   exclusion_reason
        bool   enabled
        text   source
    }
    categories {
        uuid   id PK
        text   name
        enum   kind "expense | income"
        bool   is_consumption "false = debt principal, investing, transfers"
    }
    merchant_aliases {
        uuid   id PK
        int    priority
        text   pattern UK
        text   display_name
        bool   is_payg
    }
    overrides {
        uuid   transaction_id PK_FK
        uuid   category_id FK
        enum   exclusion_reason
        bool   force_included
        text   note
    }
    budget_lines {
        uuid    id PK
        uuid    category_id FK
        date    effective_from "the period this figure starts applying to"
        numeric amount "null = deliberately not budgeted from here on"
        text    note
    }
    settings {
        bool   id PK "singleton"
        int    statement_start_day "16"
        numeric large_purchase_threshold
        text   timezone
    }
    sync_runs {
        uuid   id PK
        text   trigger
        enum   status
        int    accounts_synced
        int    transactions_new
        int    uncategorised_count
        jsonb  details
    }
```

## Why it is split this way

### One line separates everything: fetched vs derived

`transactions_raw` is the only table that costs an API call to produce. Every
other classification table is an input to, or an output of, a pure function over
it. That is what makes "change a rule, replay history" a local operation rather
than a re-sync.

The boundary is enforced, not just documented:

- A trigger on `transactions_raw` rejects any change to `id`, `akahu_id` or
  `account_id`, and rejects a change to the payload that does not stamp
  `revised_at`. Bugs that would quietly rewrite history fail loudly instead.
- `transactions_enriched` holds no fact that is not recomputable. It can be
  truncated and rebuilt; nothing is lost.
- `overrides` is a separate table, and — more importantly — it is resolved by
  the `transactions` view at read time rather than baked into the derived layer.
  `scripts/recompute.ts` does not read the overrides table at all. It therefore
  cannot clobber a manual verdict even in principle, rather than merely being
  careful not to. There is also exactly one implementation of override
  precedence, in the view, instead of one in SQL and a second in TypeScript
  drifting apart.

  Verified: override a transaction from Groceries to Eating out, run a full
  recompute, and the derived row still says Groceries while the effective
  category stays Eating out.

### `categories` exists as a table, not a text column

The brief listed `category` as a string on the enriched row. It is a table here
because two facts have to live somewhere: whether a category is `expense` or
`income`, and whether it is consumption.

Savings and investing are the reason. A $300 standing order into a savings
account and a $400 Sharesies buy are real outflows, but the headline "what I
spend" figure is meaningless if it counts $8,400 a year of money you still have.
That is a property of the category, not of each transaction, so
`categories.is_consumption` carries it and every page reads the same flag. The
alternative is the same list of category names hardcoded in five different
queries, drifting apart.

This is also why saving is a *category* rather than an exclusion. It genuinely
left the account, so it has to stay in the ledger and reconcile against the
bank; what keeps it out of the spending figure is the flag, not a deletion.

### One ordered rules table, not five

The rules file separates passthroughs, exclusions, unidentified patterns and
categories into different arrays, but they are all doing the same job: first
pattern that matches the description wins. Splitting them across tables would
mean the evaluation order lived in application code, where it is invisible and
easy to get backwards. One table with an integer `priority` makes the order
data, inspectable with a query.

The bands, and why the order between them matters:

| Band   | Rule type      | Why it sits there                                                                                                    |
| ------ | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1000   | passthrough    | money that arrives and leaves again without ever being yours. Empty here — a salary is already net — but kept, because the band has to beat income if it is ever used |
| 2000   | exclusions     | must beat every category, or paying off the card is counted on top of the purchases it settles                         |
| 3000   | unidentified   | named explicitly so the still-to-sort count means "a rule is missing" and nothing else                                 |
| 4000   | income         | inflow only                                                                                                            |
| 5000   | expense        | the file's own order, preserved exactly: pharmacy before groceries, coffee before eating out                           |

### `applies_to`: the column the rules file implies but cannot express

Several patterns appear on both sides of the ledger:

| Pattern         | As an outflow        | As an inflow            |
| --------------- | -------------------- | ----------------------- |
| `sharesies`     | Savings & investing  | Investment withdrawals  |
| `kernel wealth` | Savings & investing  | Investment withdrawals  |
| `\binterest\b`  | Fees & interest      | Interest earned         |

Priority alone cannot separate these: whichever rule sits higher would claim
both directions. So rules carry a direction. Income rules are `inflow`-only and
sit above the expense band; expense rules are direction agnostic.

That last part is deliberate. An expense rule matching `any` direction means a
refund from a shop lands back in that shop's category as a positive amount,
reducing the category total, instead of being booked as income or falling out of
the rule set entirely. It is also why `refund` is *not* an income pattern here,
tempting though it looks: it would turn every returned jumper into earnings.

### The exclusion enum is the totals bug, made structural

`exclusion_reason` is `internal_transfer | card_payment | passthrough |
unidentified`, nullable. A check constraint says a row may carry an exclusion
reason or a category, never both:

```sql
constraint enriched_single_classification check (
  exclusion_reason is null or category_id is null
)
```

That constraint is what makes "classified exactly once" a property of the
database rather than a hope the reconciliation test checks after the fact. The
`reconciliation` view then reduces to arithmetic:

```
net_cash = income_signed + spend_signed + non_consumption_signed
         + excluded_signed + unclassified_signed
```

All five terms keep the Akahu sign convention, so `spend_signed` is negative.
This is the brief's `expenses − income + excluded` identity with the signs left
alone instead of flipped, which means the test can compare against
`sum(amount)` directly with no place for a sign error to hide.

Note that non-consumption sits in its own term rather than inside `spend`. It is
neither excluded nor living costs, and giving it a name in the identity is what
keeps it visible while out of the headline.

The constraint above only makes the *stored* classification single-valued.
Overrides are resolved at read time and live in a different table, so every term
in the identity has to be computed from the resolved verdict — the `transactions`
view — and never from `transactions_enriched`. Reading one term from each is how
the identity broke once already: with the two agreeing on every row that had no
override, a database seeded from the rules file reconciled perfectly while the
real one, where the manual edits are, was out by five figures. A term keyed on
`transactions_enriched` is not a slightly stale reading of the ledger. It counts
every overridden transaction twice or not at all, and a seeded test database
cannot see it.

For the same reason `unclassified_signed` keys on *having neither a category nor
an exclusion* rather than on `classified_by = 'unmatched'`. Force-including a
transaction the rules had excluded clears the exclusion without supplying a
category, so it is `classified_by = 'override'` and belongs to no other term.
Keying on the resolved values is what makes the terms a partition rather than a
near-complete cover.

### A credit card is counted on the card, never on the payment

The card is a liability account, so the same money appears twice: once as each
purchase charged to the card, and once as the payment that settles them.

| Transaction | Treatment |
| --- | --- |
| A purchase charged to the Visa | the cost. Categorised normally |
| `CC PAYMENT ANZ VISA` from the everyday account | the settlement — excluded as `card_payment` |
| `PAYMENT RECEIVED - THANK YOU` on the card | the other leg of the same settlement — also excluded |

Counting either leg of the payment would double the month. Counting neither leg
of the purchases would empty it. Both legs of the settlement are excluded and
every purchase is kept, which is the only arrangement that reconciles.

This is also the failure mode behind the staleness warnings. If a card's
transactions stop arriving but the payment settling them keeps arriving from the
everyday account, spending is *understated* rather than merely incomplete — and
nothing about the totals looks wrong. `account_health` exists to make that
visible before it is believed.

### Passthroughs net at read time, not at write time

Unused here, and kept anyway.

The mechanism: both legs of a passthrough — money in that was never yours, and
the payment straight back out — are stored, both flagged `passthrough`, and both
excluded from spending and income. Any retained difference is computed by the
dashboard from those excluded rows.

Netting the pair into a single synthetic transaction at write time is the
alternative, and it is worse: it invents a row the bank never sent, breaks the
one-to-one relationship between raw and enriched, and makes the reconciliation
identity unverifiable against the bank.

A salaried employee has none of this. PAYE, KiwiSaver and student loan are all
deducted before the pay reaches the account, so what arrives is simply income.
The band stays because it costs nothing while empty, keeps the schema and the
reconciliation identity shared with the fork this came from, and models a
situation that is not impossible.

### Periods are a function, not a stored column

`statement_period_start(date, start_day)` is immutable SQL. Storing the period
on each row would mean rewriting every row to change the start day. As a
function it is a settings change.

`start_day = 1` — the default here — makes every period an ordinary calendar
month, because `date_trunc('month', d)` is exactly what the function returns
when the day-of-month test is trivially true. No separate calendar-month code
path exists, which is the point: someone who would rather their month ran payday
to payday changes one dropdown and every figure in the app regroups.

`start_day` is capped at 28, so no month can produce a partial period.

### A budget is versioned, not stored per period

`budget_lines` records an amount and the date it takes effect. The budget in
force for a period is the newest line at or before that period's start, resolved
by `budget_for_period(date)` and nowhere else.

The obvious alternative is a row per category per period, and it fails the same
way a stored period column would: a budget is a standing intention that changes
two or three times a year, so materialising it against every period means
writing twenty rows a month forever, and "what was I aiming for in March"
becomes a question about whether those rows happened to be written. Versioning
makes the answer structural. Set rent once and every later period inherits it;
change it in August and July keeps the figure it was actually judged against.

Two details carry weight:

- **`amount` is nullable, and null means "stop budgeting this".** Without it,
  clearing a limit would have to delete the line, and the older line underneath
  would resurface as though the decision had never been made.
- **`effective_from` is a plain date, not a key onto a period.** Periods are
  computed from `settings.statement_start_day` and move when that setting
  changes. "Newest line at or before the period start" keeps resolving sensibly
  across such a change; a stored period key would silently orphan every line.

Expected-to-date is deliberately not a straight-line pro-rate of the limit.
Rent lands on day one and the power bill on day twenty, so a linear budget line
reports every fixed cost as a blowout for the first half of the period and then
quietly recovers. Each category is shaped by its own history instead — the share
of a typical period's spend that has landed by this day — falling back to
straight-line only where there is no history to shape it with. It is the same
argument as the pace comparison on the dashboard, applied per category.

### `sync_runs`

A daily sync that silently stops returning transactions looks exactly like a
quiet month. One row per attempt with `transactions_new` and
`uncategorised_count` turns that silence into a queryable fact.

## Sign convention

Akahu's, preserved end to end and never flipped:

- `amount < 0` — money left the account
- `amount > 0` — money entered the account

Credit cards follow the same rule: a purchase is negative, a payment to the card
is positive. Presentation is the UI's problem.

## Time convention

New Zealand time, everywhere, and never inferred from the environment. The zone
is named once in `src/lib/time.ts` and everything else goes through it.

The reason it has to be stated rather than assumed is that nothing this app runs
on is in New Zealand by default. Containers are UTC, Postgres takes its session
zone from the server, and the browser takes it from the device. New Zealand is
UTC+12/+13, so a UTC clock is still on yesterday for the first half of every
local day - long enough for a transaction at 00:30 to be filed under the day
before, and on the 1st of a month, under the month before, where it is counted
against a period that has already been read and reconciled.

Two kinds of value, and the difference is the whole thing:

- **Calendar dates** - `transactions.date`, `period_start`, `effective_from`.
  A day, with no time and no zone. Carried as `YYYY-MM-DD` strings, stored in
  `date` columns, and pegged at UTC midnight where a JavaScript `Date` is
  unavoidable. The peg is not a timezone choice; it is a fixed point, and such
  values are read back with UTC accessors and formatted with `timeZone: 'UTC'`
  so the day survives the round trip.
- **Instants** - every `timestamptz` column, and anything from `new Date()`. A
  real point in time, which has to be told which day it was *here* before it can
  be shown. `nzDate` does the conversion; `dateTime` does the display.

The two places the conversion actually happens:

- **Ingest.** Akahu sends instants. `writeTransactions` converts each one to the
  New Zealand day it fell on before it becomes a `date`.
- **The connection.** Every pool opens with `TimeZone=Pacific/Auckland` as a
  startup parameter, so `current_date` and `now()` answer in local time. Three
  things depend on it: which period is the current one, how far into itself a
  period is, and how long an account has been silent.

`settings.timezone` records the zone but does not choose it - the connection
that would have to read the setting is the same connection whose zone is being
set. It is there for the day this stops being a one-country app.

## Database roles

The original design used Supabase Row Level Security. On self-hosted Postgres
there is no PostgREST and no browser-facing database connection, so the question
is no longer "which rows may a client see" — the browser never sees any — but
"which tables may each part of the app write".

| Role            | Reads      | Writes                                                   |
| --------------- | ---------- | -------------------------------------------------------- |
| `finance_owner` | everything | everything. Migrations only.                             |
| `finance_web`   | everything | `overrides`, `rules`, `merchant_aliases`, `categories`, `budget_lines`, `settings` |
| `finance_sync`  | everything | `accounts`, `transactions_raw`, `transactions_enriched`, `sync_runs` |

The split is what makes the read-time override design safe: `finance_web` has no
write access to the derived layer at all, so the UI's only way to recategorise a
transaction is to write an override — which is exactly the behaviour we want,
enforced by privileges rather than by convention. Symmetrically, `finance_sync`
cannot touch rules or overrides.

Both views are `security_invoker`, so they cannot become a hole around the
privileges on the tables underneath them.

Roles are created `NOLOGIN` with no password, so nothing secret is committed.
Grant them login separately and point `DATABASE_URL_WEB` and `DATABASE_URL_SYNC`
at them; both fall back to `DATABASE_URL`, which is what local development uses.

Still outstanding: the app itself has no authentication. Behind Coolify on a
private host that may be acceptable, but it should be a conscious decision
rather than an oversight.
