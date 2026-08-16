import { Rail, TabBar } from '../../components/nav.tsx'
import { isProtected } from '../../lib/auth.ts'
import { getHealth } from '../../lib/queries.ts'

/**
 * The signed-in shell: rail on a laptop, tab bar on a phone.
 *
 * Everything under here is behind the password when one is set, so the rail is
 * free to say what the ledger actually looks like.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // The layout renders on every page, including before the database has ever
  // been reachable. A failed health check must not be the thing that stops the
  // app rendering the page that would explain why.
  const health = await getHealth().catch(() => null)

  return (
    <>
      <div className="shell">
        <Rail health={health} canSignOut={isProtected()} />
        <main className="main">{children}</main>
      </div>
      <TabBar />
    </>
  )
}
