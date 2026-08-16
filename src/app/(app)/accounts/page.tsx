import { CsvUpload } from '../../../components/csv-upload.tsx'
import { Passkeys } from '../../../components/passkeys.tsx'
import { isProtected } from '../../../lib/auth.ts'
import { getAccounts, getRecentSyncs, getSettings } from '../../../lib/queries.ts'
import { listPasskeys } from '../../../lib/webauthn.ts'
import { dateTime, fullDate, money, plural } from '../../../lib/format.ts'
import { setStatementStartDay } from '../../actions.ts'

export const dynamic = 'force-dynamic'

const ordinal = (n: number) => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${suffix}`
}

export default async function AccountsPage() {
  const [accounts, syncs, settings, passkeys] = await Promise.all([
    getAccounts(),
    getRecentSyncs(6),
    getSettings(),
    listPasskeys(),
  ])

  const startDay = settings.statementStartDay
  const synced = accounts.filter((account) => account.source === 'akahu')
  const manual = accounts.filter((account) => account.source === 'csv')

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Accounts &amp; setup</h1>
          <p>
            Where the numbers come from, and whether each source is still up to date. An account
            that stops arriving does not break anything — it just goes quiet, and quiet is
            indistinguishable from a thrifty month. That is what this page is for.
          </p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>When your month starts</h2>
            <p>
              Everything in the app is grouped by this. Changing it regroups your whole history
              straight away — nothing is stored per month, so there is nothing to rebuild.
            </p>
          </div>
        </div>

        <form action={setStatementStartDay} className="toolbar">
          <div className="field">
            <label htmlFor="statementStartDay">Starts on the</label>
            <select id="statementStartDay" name="statementStartDay" defaultValue={startDay}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                <option key={day} value={day}>
                  {ordinal(day)}
                </option>
              ))}
            </select>
          </div>
          <button className="btn" type="submit">
            Save
          </button>
          <span className="note">
            {startDay === 1
              ? 'Ordinary calendar months, 1st to the end. Set this to your payday instead if you would rather each month ran pay to pay.'
              : `Runs the ${ordinal(startDay)} to the ${ordinal(startDay - 1)} of the following month.`}{' '}
            The latest it can be is the 28th, because no later day exists in every month.
          </span>
        </form>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Connected accounts</h2>
            <p>
              Pulled from Akahu once a day. &ldquo;Not synced&rdquo; means the sync has not reached
              the account, not that the account is quiet — a card that gets used twice a month is
              not a fault.
            </p>
          </div>
        </div>

        {synced.length === 0 ? (
          <div className="empty">
            <svg className="empty-art" viewBox="0 0 48 48" aria-hidden>
              <path d="M7 19 24 9l17 10M10 22v16M19 22v16M29 22v16M38 22v16M6 40h36" />
            </svg>
            <strong>No accounts connected yet</strong>
            Add your Akahu tokens to <code>.env</code>, then run <code>npm run backfill</code> to
            pull your history in.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th style={{ width: 130 }}>Bank</th>
                  <th className="col-amount" style={{ width: 130 }}>
                    Balance
                  </th>
                  <th className="col-amount" style={{ width: 90 }}>
                    Rows
                  </th>
                  <th style={{ width: 190 }}>History from</th>
                  <th style={{ width: 120 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {synced.map((account) => (
                  <tr key={account.id}>
                    <td style={{ fontWeight: 600 }}>{account.name}</td>
                    <td style={{ color: 'var(--ink-muted)', fontSize: 13 }}>
                      {account.institution}
                    </td>
                    <td className="col-num">
                      {account.balance === null ? '—' : money(account.balance)}
                    </td>
                    <td className="col-num">{account.transactionCount}</td>
                    <td style={{ fontSize: 13, color: 'var(--ink-muted)' }}>
                      {account.oldestTransaction ? fullDate(account.oldestTransaction) : 'nothing yet'}
                    </td>
                    <td>
                      {account.isStale ? (
                        <span className="tag tag-warn">not synced</span>
                      ) : (
                        <span className="tag tag-living">up to date</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Import a statement</h2>
            <p>
              For any card Akahu cannot reach — a store card, or a bank it has no connection to.
              Export a CSV and drop it in. Importing the same file twice is safe: rows already here
              are skipped.
            </p>
          </div>
        </div>

        {manual.map((account) => (
          <div key={account.id} className="account-row">
            <div className="account-name">
              <strong>{account.name}</strong>
              <small>{account.institution}</small>
            </div>
            <div className="account-facts">
              <span>{plural(account.transactionCount, 'transaction')}</span>
              {account.latestTransaction && <span>newest {fullDate(account.latestTransaction)}</span>}
            </div>
            {account.isStale ? (
              <span className="tag tag-warn">{account.daysSinceTransaction} days behind</span>
            ) : (
              <span className="tag tag-living">up to date</span>
            )}
          </div>
        ))}

        <div style={{ marginTop: manual.length > 0 ? 18 : 0 }}>
          <CsvUpload />
        </div>

        {manual.some((account) => account.isStale) && (
          <p className="note" style={{ marginTop: 14 }}>
            While this is behind, your spending is understated rather than merely incomplete: the
            payment that settles those purchases is excluded whether or not the purchases have been
            imported.
          </p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Passkeys</h2>
            <p>
              A passkey signs you in with whatever already unlocks the device - Face ID, a
              fingerprint, the laptop&rsquo;s screen lock. The password in <code>APP_PASSWORD</code>{' '}
              never stops working, so losing a device locks nothing away.
            </p>
          </div>
        </div>

        <Passkeys passkeys={passkeys} protectedApp={isProtected()} />
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Recent syncs</h2>
            <p>
              A sync that quietly stops returning transactions looks exactly like a quiet month.
              This is how you tell the difference.
            </p>
          </div>
        </div>

        {syncs.length === 0 ? (
          <div className="empty">
            <strong>No syncs yet</strong>
            Run <code>node scripts/sync.ts</code>, or wait for the scheduled job to run overnight.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 200 }}>When</th>
                  <th style={{ width: 110 }}>Started by</th>
                  <th style={{ width: 120 }}>Result</th>
                  <th className="col-amount" style={{ width: 100 }}>
                    New
                  </th>
                  <th className="col-amount" style={{ width: 140 }}>
                    Still to sort
                  </th>
                </tr>
              </thead>
              <tbody>
                {syncs.map((run) => (
                  <tr key={run.startedAt}>
                    <td style={{ fontSize: 13 }}>
                      {dateTime(run.startedAt)}
                    </td>
                    <td style={{ fontSize: 13, color: 'var(--ink-muted)' }}>{run.trigger}</td>
                    <td>
                      <span
                        className={`tag ${
                          run.status === 'success'
                            ? 'tag-living'
                            : run.status === 'running'
                              ? 'tag-ghost'
                              : 'tag-alert'
                        }`}
                      >
                        {run.status === 'success' ? 'fine' : run.status}
                      </span>
                    </td>
                    <td className="col-num">{run.transactionsNew}</td>
                    <td className="col-num">{run.uncategorised ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}
