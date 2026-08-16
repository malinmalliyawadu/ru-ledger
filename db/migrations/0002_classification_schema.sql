-- Classification schema: categories, ordered rules, aliases, overrides, and the
-- derived enrichment layer.
--
-- The whole point of this separation: transactions_enriched is a cache. It can
-- be dropped and rebuilt from transactions_raw + rules + merchant_aliases +
-- overrides at any time, so rules can change daily without re-fetching a byte
-- from Akahu.

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------

create type category_kind as enum ('expense', 'income');

create table categories (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  slug           text not null,
  kind           category_kind not null,

  -- false for loan repayments, investing and personal transfers: real money
  -- movements, but not living costs. Headline spend excludes these by default
  -- while they stay individually visible.
  is_consumption boolean not null default true,

  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (kind, name),
  unique (kind, slug)
);

comment on column categories.is_consumption is
  'false = the money is real but is not consumption (debt principal, investing, transfers to family). Excluded from the headline "what I spend" figure, never hidden.';

create trigger categories_set_updated_at
  before update on categories
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- rules
-- ---------------------------------------------------------------------------

create type exclusion_reason as enum (
  'internal_transfer',  -- money moving between my own accounts
  'card_payment',       -- paying a card off; the purchases it settles are the real spend
  'passthrough',        -- gross contracting pay in, tax provider out; only the net is mine
  'unidentified'        -- descriptor carries no usable information
);

create type rule_type as enum (
  'passthrough_in',
  'passthrough_out',
  'exclusion',
  'unidentified',
  'category'
);

-- Which side of the ledger a rule may match. This exists because three
-- patterns are genuinely ambiguous by description alone and are only
-- separable by direction:
--   'sharesies' -> investing (outflow) vs a withdrawal (inflow)
--   'car park'  -> paying for parking (outflow) vs rent received (inflow)
create type rule_direction as enum ('any', 'inflow', 'outflow');

create table rules (
  id               uuid primary key default gen_random_uuid(),
  priority         integer not null,
  rule_type        rule_type not null,
  pattern          text not null,
  applies_to       rule_direction not null default 'any',

  -- required when rule_type = 'category'
  category_id      uuid references categories (id) on delete restrict,
  -- required when rule_type in ('exclusion', 'unidentified', 'passthrough_*')
  exclusion_reason exclusion_reason,

  enabled          boolean not null default true,
  source           text not null default 'manual',
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Idempotent seeding: re-running the seed updates rules in place, so rule ids
  -- referenced by transactions_enriched stay stable.
  unique (rule_type, pattern, applies_to),

  constraint rules_category_shape check (
    (rule_type = 'category' and category_id is not null and exclusion_reason is null)
    or
    (rule_type <> 'category' and category_id is null and exclusion_reason is not null)
  )
);

comment on table rules is
  'Ordered classifier. Evaluated by (priority, id) ascending; first enabled rule whose pattern matches the description and whose applies_to admits the amount direction wins. Order is load-bearing: pharmacy (8) must be tested before groceries (9), and exclusions before every category.';

create index rules_eval_idx on rules (priority, id) where enabled;

create trigger rules_set_updated_at
  before update on rules
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- merchant_aliases
-- ---------------------------------------------------------------------------

create table merchant_aliases (
  id           uuid primary key default gen_random_uuid(),
  priority     integer not null,
  pattern      text not null unique,
  display_name text not null,

  -- pay-as-you-go merchants: charge on a cycle-ish rhythm but are not
  -- subscriptions, so the recurring page should not flag them as cancelled.
  is_payg      boolean not null default false,

  enabled      boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table merchant_aliases is
  'Descriptor drift: the same business appears as several strings over time. First matching alias by (priority, id) supplies the display name.';

create index merchant_aliases_eval_idx on merchant_aliases (priority, id) where enabled;

create trigger merchant_aliases_set_updated_at
  before update on merchant_aliases
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- overrides
-- ---------------------------------------------------------------------------

create table overrides (
  transaction_id   uuid primary key references transactions_raw (id) on delete cascade,
  category_id      uuid references categories (id) on delete restrict,
  exclusion_reason exclusion_reason,

  -- explicitly un-exclude something the rules excluded
  force_included   boolean not null default false,

  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint overrides_not_empty check (
    category_id is not null or exclusion_reason is not null or force_included
  ),
  constraint overrides_coherent check (
    not (force_included and exclusion_reason is not null)
  )
);

comment on table overrides is
  'Manual verdicts. Always beat rules, are never written by a recompute, and survive any change to the rule set.';

create trigger overrides_set_updated_at
  before update on overrides
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- transactions_enriched  (derived, fully recomputable)
-- ---------------------------------------------------------------------------

create type classified_by as enum ('rule', 'override', 'unmatched');

create table transactions_enriched (
  transaction_id        uuid primary key references transactions_raw (id) on delete cascade,
  category_id           uuid references categories (id) on delete restrict,
  merchant_display_name text,
  exclusion_reason      exclusion_reason,

  is_recurring          boolean not null default false,
  is_payg               boolean not null default false,
  is_one_off            boolean not null default false,
  recurrence_days       integer,

  rule_id               uuid references rules (id) on delete set null,
  alias_id              uuid references merchant_aliases (id) on delete set null,
  classified_by         classified_by not null,

  computed_at           timestamptz not null default now(),

  -- The partition that makes reconciliation possible: a transaction is either
  -- excluded from the totals, or it carries a category. Never both, never
  -- neither unless it is genuinely unmatched.
  constraint enriched_single_classification check (
    exclusion_reason is null or category_id is null
  )
);

create index transactions_enriched_category_idx  on transactions_enriched (category_id);
create index transactions_enriched_exclusion_idx on transactions_enriched (exclusion_reason);
create index transactions_enriched_recurring_idx on transactions_enriched (is_recurring) where is_recurring;
