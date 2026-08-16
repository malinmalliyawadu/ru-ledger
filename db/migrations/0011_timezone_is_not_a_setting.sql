-- settings.timezone records the zone. It does not choose it.
--
-- The column has been there since 0003 and has never been read by anything,
-- which makes it worse than absent: it looks like the switch you would reach
-- for to change how the app tells the time, and changing it does nothing at
-- all. Meanwhile the zone that actually decides what day it is arrives as a
-- startup parameter on every connection, from src/lib/time.ts.
--
-- It cannot sensibly work the other way round. Reading the setting requires a
-- connection, and the connection's zone is the thing being set - so `now()` in
-- the query that fetched the setting would already have answered in the wrong
-- zone. The app would be choosing its timezone using a clock it had not
-- configured yet.
--
-- So the column stays, as a record of where this ledger lives, and says so.
-- Left here for the day this stops being a one-country app, at which point the
-- honest fix is a per-connection zone rather than a value read after the fact.

comment on column settings.timezone is
  'Informational: where this ledger lives. The app takes its timezone from src/lib/time.ts, sent as a startup parameter on every connection - editing this column changes nothing.';
