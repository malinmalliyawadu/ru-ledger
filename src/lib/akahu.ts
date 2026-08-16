/**
 * Akahu API client. Personal App: one user, no webhooks, no payments.
 *
 * https://developers.akahu.nz — base URL https://api.akahu.io/v1, with two
 * credentials on every request:
 *
 *   Authorization: Bearer <user access token>
 *   X-Akahu-Id:    <app id token>
 *
 * They are easy to swap, and swapping them produces a 401 that looks like an
 * expired token, so the error for that case says so explicitly.
 */

const BASE_URL = 'https://api.akahu.io/v1'

export type AkahuAccount = {
  _id: string
  name: string
  status?: string
  formatted_account?: string
  type?: string
  connection?: { _id: string; name: string; logo?: string }
  balance?: { currency: string; current: number; available?: number; overdrawn?: boolean }
  refreshed?: { balance?: string; transactions?: string; party?: string }
  attributes?: string[]
}

/** Anything that can round-trip through the `raw` jsonb column. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export type AkahuTransaction = {
  _id: string
  _account: string
  _connection?: string
  date: string
  description: string
  amount: number
  balance?: number
  type?: string
  hash?: string
  merchant?: { _id: string; name: string; website?: string }
  category?: { _id: string; name: string; groups?: Record<string, { _id: string; name: string }> }
  // Typed as JSON rather than unknown so the whole transaction can be stored
  // verbatim in the raw jsonb column without a cast.
  meta?: Record<string, JsonValue>
}

type Envelope<T> = {
  success: boolean
  items?: T
  item?: T
  cursor?: { next?: string | null }
  message?: string
}

export class AkahuError extends Error {
  // Declared and assigned explicitly rather than as constructor parameter
  // properties: scripts run straight through Node's type stripping, which has
  // no way to emit the implied assignments.
  readonly status: number
  readonly body: string

  constructor(message: string, status: number, body: string) {
    super(message)
    this.name = 'AkahuError'
    this.status = status
    this.body = body
  }
}

export type AkahuClient = ReturnType<typeof createAkahuClient>

export function createAkahuClient(options: { userToken?: string; appToken?: string } = {}) {
  const userToken = options.userToken ?? process.env.AKAHU_USER_TOKEN
  const appToken = options.appToken ?? process.env.AKAHU_APP_ID_TOKEN

  if (!userToken || !appToken) {
    throw new Error(
      'AKAHU_USER_TOKEN and AKAHU_APP_ID_TOKEN must both be set. See .env.example.',
    )
  }

  const headers = {
    Authorization: `Bearer ${userToken}`,
    'X-Akahu-Id': appToken,
    Accept: 'application/json',
  }

  async function request<T>(
    path: string,
    params?: Record<string, string | undefined>,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<Envelope<T>> {
    const url = new URL(BASE_URL + path)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }

    // Akahu rate-limits, and a backfill is exactly the shape of request that
    // trips it. Back off and retry rather than losing a page of history.
    const maxAttempts = 5
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(url, { headers, method })

      if (response.ok) {
        const body = (await response.json()) as Envelope<T>
        if (body.success === false) {
          throw new AkahuError(body.message ?? 'Akahu reported failure', response.status, JSON.stringify(body))
        }
        return body
      }

      const body = await response.text()

      if (response.status === 401) {
        throw new AkahuError(
          'Akahu rejected the credentials (401). Check the two tokens are not swapped: ' +
            'the user access token goes in Authorization, the app ID token in X-Akahu-Id.',
          401,
          body,
        )
      }

      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === maxAttempts) {
        throw new AkahuError(`Akahu ${response.status} on ${path}`, response.status, body)
      }

      const retryAfter = Number(response.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30_000, 2 ** attempt * 500)

      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  return {
    /** Identity check. The cheapest way to prove the credentials work. */
    async me(): Promise<Record<string, unknown>> {
      const body = await request<Record<string, unknown>>('/me')
      return (body.item ?? body.items ?? {}) as Record<string, unknown>
    },

    async accounts(): Promise<AkahuAccount[]> {
      const body = await request<AkahuAccount[]>('/accounts')
      return body.items ?? []
    },

    /**
     * Asks Akahu to pull fresh data from the banks.
     *
     * Asynchronous — it returns as soon as the refresh is queued, and the data
     * lands some time later. Personal Apps also enforce a one-hour minimum
     * between manual refreshes and refresh daily on their own schedule, so this
     * is an optimisation for sync timing rather than something to call often.
     */
    async refresh(): Promise<void> {
      await request<unknown>('/refresh', undefined, 'POST')
    },

    /**
     * Every transaction for one account in a window, following the cursor to
     * the end.
     *
     * Note `start` is EXCLUSIVE and `end` is inclusive. Callers resuming from a
     * previous sync should therefore overlap deliberately rather than passing
     * the last date they saw, or they will drop a day. Upserts on the natural
     * key make the overlap free.
     */
    async *transactions(
      accountId: string,
      window: { start: Date; end: Date },
    ): AsyncGenerator<AkahuTransaction[]> {
      let cursor: string | undefined

      do {
        const body = await request<AkahuTransaction[]>(`/accounts/${accountId}/transactions`, {
          start: window.start.toISOString(),
          end: window.end.toISOString(),
          cursor,
        })

        const items = body.items ?? []
        if (items.length > 0) yield items

        cursor = body.cursor?.next ?? undefined
      } while (cursor)
    },
  }
}
