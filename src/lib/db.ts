import postgres from 'postgres'

/**
 * Postgres connections. Server-side only: nothing in this file may be imported
 * into a client component, and the browser never opens a database socket.
 *
 * Three roles, defined in db/migrations/0004_roles_and_grants.sql. `web` and
 * `sync` fall back to the owner connection when their URLs are unset, which is
 * what local development uses.
 */
export type Role = 'owner' | 'web' | 'sync'

const ENV_VAR: Record<Role, string> = {
  owner: 'DATABASE_URL',
  web: 'DATABASE_URL_WEB',
  sync: 'DATABASE_URL_SYNC',
}

function urlFor(role: Role): string {
  const url = process.env[ENV_VAR[role]] || process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      `${ENV_VAR[role]} (or DATABASE_URL) is not set. Copy .env.example to .env and fill it in.`,
    )
  }
  return url
}

/**
 * TLS is opt-in via PGSSLMODE, and off by default.
 *
 * The deployed topology is app and Postgres on the same private Docker network
 * inside Coolify, which does not speak TLS. Inferring "not localhost, therefore
 * encrypt" broke exactly that case, and inferring the opposite would silently
 * send credentials in the clear to a remote host. So it is explicit: set
 * PGSSLMODE=require when the database is somewhere the traffic leaves the box.
 */
function sslFor(): postgres.Options<{}>['ssl'] {
  switch (process.env.PGSSLMODE) {
    case 'require':
      return 'require'
    // Managed Postgres with a self-signed certificate.
    case 'no-verify':
      return { rejectUnauthorized: false }
    case 'prefer':
      return 'prefer'
    default:
      return false
  }
}

function create(role: Role): postgres.Sql {
  return postgres(urlFor(role), {
    max: role === 'web' ? 10 : 4,
    idle_timeout: 20,
    ssl: sslFor(),
    transform: { undefined: null },
  })
}

/** Short-lived connection for scripts. Call `.end()` when finished. */
export function connect(role: Role = 'owner'): postgres.Sql {
  return create(role)
}

/**
 * Long-lived pool for the Next.js server.
 *
 * Created on first use rather than on import. `next build` imports every route
 * module to collect page data, and it does that in an image that has no
 * database and no DATABASE_URL — so constructing the pool at module scope makes
 * the production build fail on a machine that is not supposed to have database
 * credentials in the first place.
 *
 * Cached on globalThis so a dev-mode hot reload reuses the pool instead of
 * leaking a new one on every edit.
 */
const globalForDb = globalThis as unknown as { financeDb?: postgres.Sql }

function pool(): postgres.Sql {
  if (!globalForDb.financeDb) globalForDb.financeDb = create('web')
  return globalForDb.financeDb
}

/**
 * Behaves exactly like a postgres.js instance — `db\`select …\`` — but resolves
 * the real pool on first access. The proxy exists purely to keep that lazy
 * behaviour invisible at the ~30 call sites.
 */
export const db: postgres.Sql = lazy(() => pool())

/**
 * The sync connection, for the one thing the app does that writes the ledger:
 * importing a statement CSV from the Accounts page.
 *
 * Kept separate from `db` on purpose. Page rendering goes through a role that
 * cannot write transactions_raw at all, so a mistake in a query that renders a
 * table still cannot touch the ledger. Ingesting is a different job and says so.
 */
const globalForSync = globalThis as unknown as { financeSyncDb?: postgres.Sql }

function syncPool(): postgres.Sql {
  if (!globalForSync.financeSyncDb) globalForSync.financeSyncDb = create('sync')
  return globalForSync.financeSyncDb
}

export const syncDb: postgres.Sql = lazy(() => syncPool())

/**
 * Wraps a postgres.js instance so it behaves normally — `db\`select …\`` — while
 * resolving the real pool on first access. The proxy exists purely to keep that
 * lazy behaviour invisible at the call sites.
 */
function lazy(resolve: () => postgres.Sql): postgres.Sql {
  return new Proxy(function noop() {} as unknown as postgres.Sql, {
    apply: (_target, _thisArg, args: unknown[]) =>
      (resolve() as unknown as (...a: unknown[]) => unknown)(...args),
    get: (_target, property) => Reflect.get(resolve(), property),
    has: (_target, property) => Reflect.has(resolve(), property),
  })
}
