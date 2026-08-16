-- Reconciliation must read the same ledger the rest of the app reads.
--
-- The previous definition mixed two sources of truth. income_signed and
-- spend_signed came from the `transactions` view, which resolves overrides.
-- excluded_signed, unclassified_signed and half of non_consumption_signed read
-- transactions_enriched directly, which does not. The five buckets are supposed
-- to partition the ledger, so on any database with no overrides they agreed and
-- drift was zero — and every manual recategorisation pushed drift further out.
--
-- Which direction depended on the edit. Overriding an excluded transaction into
-- a category counted it in both excluded_signed (pre-override) and spend_signed
-- (post-override). Overriding a categorised transaction into an exclusion
-- counted it in neither. So the one banner that exists to say "your ledger does
-- not add up" was firing at a ledger that added up fine, in proportion to how
-- much the ledger had been curated by hand.
--
-- Every bucket now reads the resolved columns. transactions_enriched is still
-- joined, but only for unenriched_count, which is genuinely a question about
-- the derived cache rather than about the money.

drop view reconciliation;

create view reconciliation with (security_invoker = on) as
select
  count(*)                                              as raw_count,
  count(*) filter (where e.transaction_id is null)      as unenriched_count,
  count(*) filter (where t.classified_by = 'unmatched') as unmatched_count,
  coalesce(sum(r.amount), 0)                            as net_cash,
  coalesce(sum(r.amount) filter (where t.counts_as_income), 0) as income_signed,
  coalesce(sum(r.amount) filter (where t.counts_as_spend), 0)  as spend_signed,
  coalesce(sum(r.amount) filter (
    where t.exclusion_reason is null
      and t.category_kind = 'expense'
      and not t.is_consumption), 0)                     as non_consumption_signed,
  coalesce(sum(r.amount) filter (where t.exclusion_reason is not null), 0) as excluded_signed,

  -- Anything carrying neither a category nor an exclusion. Broader than
  -- classified_by = 'unmatched' on purpose: force-including a transaction the
  -- rules had excluded clears the exclusion without supplying a category, so it
  -- is classified_by = 'override' and still belongs to no bucket. Keying on the
  -- resolved values rather than on classified_by is what makes these six
  -- filters a genuine partition instead of five that nearly cover everything.
  coalesce(sum(r.amount) filter (
    where t.exclusion_reason is null
      and t.category_id is null), 0)                    as unclassified_signed,

  coalesce(sum(r.amount) filter (where t.exclusion_reason = 'passthrough' and r.amount > 0), 0) as passthrough_in,
  coalesce(sum(r.amount) filter (where t.exclusion_reason = 'passthrough' and r.amount < 0), 0) as passthrough_out
from transactions_raw r
join transactions t                on t.id = r.id
left join transactions_enriched e  on e.transaction_id = r.id;

comment on view reconciliation is
  'net_cash must equal income_signed + spend_signed + non_consumption_signed + excluded_signed + unclassified_signed. Every figure resolves overrides, so a manual recategorisation moves a transaction between buckets rather than adding or dropping one. All figures keep the Akahu sign convention, so spend_signed is negative.';
