-- Core schema: accounts, immutable raw transactions, sync observability.
--
-- Sign convention (Akahu native, preserved end to end):
--   amount < 0  money left the account (purchase, transfer out, loan payment)
--   amount > 0  money entered the account (income, refund, card payment credit)
-- Credit card accounts follow the same rule: a purchase is negative, a payment
-- to the card is positive. Nothing in this database ever flips a sign; the UI
-- decides how to present it.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------

create table accounts (
  id                      uuid primary key default gen_random_uuid(),
  akahu_id                text unique not null,
  name                    text not null,
  institution             text,
  type                    text,
  currency                text not null default 'NZD',
  current_balance         numeric(14, 2),
  balance_as_at           timestamptz,
  last_synced_at          timestamptz,

  -- Backfill provenance. Kiwibank caps credit card history at 180 days on the
  -- first request and two years thereafter, so how far back we actually got is
  -- a per-account fact we have to record rather than assume.
  first_connected_at      timestamptz,
  oldest_transaction_date date,
  backfill_completed_at   timestamptz,
  backfill_notes          text,

  is_active               boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on column accounts.oldest_transaction_date is
  'Oldest transaction date Akahu actually returned for this account. Compared against the requested window to detect provider truncation.';

-- ---------------------------------------------------------------------------
-- transactions_raw  (immutable)
-- ---------------------------------------------------------------------------

create table transactions_raw (
  id           uuid primary key default gen_random_uuid(),
  akahu_id     text unique not null,
  account_id   uuid not null references accounts (id) on delete restrict,
  date         date not null,
  description  text not null,
  amount       numeric(14, 2) not null,
  raw          jsonb not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revised_at    timestamptz
);

comment on table transactions_raw is
  'Append-only ledger of what Akahu returned. akahu_id is the natural key: the sync upserts on it, so re-running a sync is a no-op. Rows are only ever updated when the upstream payload genuinely changed, which stamps revised_at.';

create index transactions_raw_date_idx        on transactions_raw (date desc);
create index transactions_raw_account_date_idx on transactions_raw (account_id, date desc);
-- Case-insensitive description matching drives categorisation replays.
create index transactions_raw_description_idx on transactions_raw (lower(description));

-- Guard: the identity of a raw row can never change. Content may only change
-- when the upstream payload itself changed (revised_at must be stamped).
create or replace function transactions_raw_immutable_guard()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id or new.akahu_id <> old.akahu_id or new.account_id <> old.account_id then
    raise exception 'transactions_raw identity is immutable (akahu_id=%)', old.akahu_id;
  end if;

  if new.raw is distinct from old.raw and new.revised_at is not distinct from old.revised_at then
    raise exception 'raw payload changed for akahu_id=% without stamping revised_at', old.akahu_id;
  end if;

  return new;
end;
$$;

create trigger transactions_raw_immutable
  before update on transactions_raw
  for each row execute function transactions_raw_immutable_guard();

-- ---------------------------------------------------------------------------
-- sync_runs  (structured log, queryable)
-- ---------------------------------------------------------------------------

create type sync_status as enum ('running', 'success', 'partial', 'failed');

create table sync_runs (
  id                     uuid primary key default gen_random_uuid(),
  trigger                text not null,          -- 'cron' | 'manual' | 'backfill'
  status                 sync_status not null default 'running',
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,
  accounts_synced        integer not null default 0,
  transactions_fetched   integer not null default 0,
  transactions_new       integer not null default 0,
  transactions_revised   integer not null default 0,
  uncategorised_count    integer,
  error                  text,
  details                jsonb not null default '{}'::jsonb
);

comment on table sync_runs is
  'One row per sync attempt. A sync that silently stops returning transactions shows up here as a run with transactions_new = 0 rather than as silence.';

create index sync_runs_started_at_idx on sync_runs (started_at desc);

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger accounts_set_updated_at
  before update on accounts
  for each row execute function set_updated_at();
