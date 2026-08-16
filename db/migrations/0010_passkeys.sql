-- Passkeys: the everyday way in.
--
-- The password in APP_PASSWORD is the root credential and stays the fallback.
-- It is the thing you can recover with when the phone holding the passkey is at
-- the bottom of a lake, and the thing a passkey is registered against in the
-- first place. Passkeys are what you actually use: Face ID on the phone that
-- checks the ledger from the supermarket carpark.
--
-- Everything stored here is public by construction. A passkey's private half
-- never leaves the authenticator, so this table holds only public keys and
-- bookkeeping - a leak of it does not let anyone in.
--
-- No user table, because there is no second user. A registered passkey means
-- "whoever holds this may see the ledger", which is the same claim the password
-- makes, and the household is one person and their phone.

create table passkeys (
  -- The credential ID the authenticator minted, base64url, exactly as it comes
  -- back from the browser. Natural key: it is what an assertion identifies
  -- itself by, so looking one up is a primary key hit and nothing else.
  id           text primary key,

  -- COSE public key, base64url. Verifying a signature is the only thing it is
  -- ever used for, so it is stored the shape the verifier wants it.
  public_key   text not null,

  -- Signature counter, as last reported. Authenticators that implement it
  -- increment on every use, so a counter that goes backwards means two things
  -- are answering for one credential - a clone. Many modern passkeys report a
  -- permanent 0, which is not suspicious, just uninformative.
  counter      bigint not null default 0,

  -- How the browser reached it: internal, hybrid, usb. Passed back on the next
  -- sign-in so the browser can offer the right prompt instead of guessing.
  transports   text[] not null default '{}',

  -- Human-facing name, because "which of these three do I delete" is the only
  -- question this page ever has to answer.
  label        text not null,

  -- multiDevice means the passkey syncs through iCloud or a password manager,
  -- so it survives losing the device. singleDevice means it does not, and
  -- deleting it here is the only way it ever goes away.
  device_type  text,
  backed_up    boolean not null default false,

  created_at   timestamptz not null default now(),
  last_used_at timestamptz,

  constraint passkeys_label_not_blank check (length(trim(label)) > 0)
);

comment on table passkeys is
  'Registered WebAuthn credentials. Public keys only; the private half stays on the authenticator. Registering one requires already being signed in, so the APP_PASSWORD is the root of trust for all of them.';

comment on column passkeys.counter is
  'Last signature counter seen. A response with a counter at or below this one is rejected as a possible clone. Authenticators that always report 0 are exempt, per the WebAuthn spec.';

-- Sign-in lists the registered credentials before it knows which one will
-- answer, and the manage page lists them newest first.
create index passkeys_created_idx on passkeys (created_at desc);

-- ---------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------

-- Adding and removing a passkey is a thing a signed-in human does from the UI,
-- which puts it on the finance_web side of the line with rules and overrides.
-- The sync role has no business here at all: it never authenticates anyone.
grant select, insert, update, delete on passkeys to finance_web;
revoke all on passkeys from finance_sync;
