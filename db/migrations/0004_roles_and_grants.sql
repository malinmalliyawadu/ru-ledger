-- Least-privilege database roles.
--
-- Replaces the Supabase RLS model. On self-hosted Postgres there is no
-- PostgREST and no browser-facing database connection: the Next.js server is
-- the only thing that ever opens a socket to this database. So the boundary
-- that matters is no longer "which rows may a client see" but "which tables may
-- each part of the app write".
--
--   finance_owner  migrations. Owns everything. Used by scripts/migrate.ts.
--   finance_web    the Next.js server. Reads everything; writes only the
--                  classification inputs a human edits from the UI.
--   finance_sync   the Akahu sync and recompute jobs. Writes the ledger and the
--                  derived layer; cannot edit rules or overrides.
--
-- The split means a SQL injection in a page handler still cannot rewrite the
-- ledger, and a bug in the sync cannot silently discard a manual override.
--
-- Roles are created NOLOGIN with no password. Grant login separately so no
-- credential is ever committed:
--
--   alter role finance_web  with login password 'â€¦';
--   alter role finance_sync with login password 'â€¦';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'finance_web') then
    create role finance_web nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'finance_sync') then
    create role finance_sync nologin;
  end if;
end;
$$;

grant usage on schema public to finance_web, finance_sync;

-- Read: both roles see everything.
grant select on all tables in schema public to finance_web, finance_sync;

-- finance_web writes only what the UI edits.
grant insert, update, delete on overrides, rules, merchant_aliases, categories to finance_web;
grant update on settings to finance_web;

-- finance_sync writes the ledger and the derived layer.
grant insert, update on accounts, transactions_raw to finance_sync;
grant insert, update, delete on transactions_enriched to finance_sync;
grant insert, update on sync_runs to finance_sync;

-- Recompute rebuilds the derived layer wholesale.
grant truncate on transactions_enriched to finance_sync;

-- Future tables inherit the same shape, so a new migration cannot accidentally
-- ship a table that is invisible to the app.
alter default privileges in schema public
  grant select on tables to finance_web, finance_sync;

comment on schema public is
  'Ledger is append-only to everything except finance_sync. transactions_raw additionally carries an immutability trigger that applies to every role including the owner.';
